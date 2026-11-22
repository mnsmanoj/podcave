package server

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"sort"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/util/validation"

	"podcave/internal/kube"
)

type multiLogReq struct {
	Pods []struct {
		Ctx       string `json:"ctx"`
		Ns        string `json:"ns"`
		Pod       string `json:"pod"`
		Container string `json:"container"`
	} `json:"pods"`
	Deployment *struct {
		Ctx  string `json:"ctx"`
		Ns   string `json:"ns"`
		Name string `json:"name"`
	} `json:"deployment"`
	// Container picks a container by name in every pod; empty means each pod's main container.
	Container string `json:"container"`
	Tail      int64  `json:"tail"`
	Since     string `json:"since"`
	Follow    *bool  `json:"follow"`
	Previous  bool   `json:"previous"`
}

func validName(ns, name string) bool {
	return len(validation.IsDNS1123Label(ns)) == 0 && len(validation.IsDNS1123Subdomain(name)) == 0
}

// handleMultiLogs merges the logs of up to kube.MaxLogSources containers, either
// an explicit list (any cluster or namespace) or every pod of a deployment,
// picking up replacement pods as they appear.
func (s *Server) handleMultiLogs(w http.ResponseWriter, r *http.Request) {
	var req multiLogReq
	if !decode(w, r, maxBody, &req) {
		return
	}
	if (len(req.Pods) == 0) == (req.Deployment == nil) {
		badRequest(w, "send either pods or deployment")
		return
	}
	if len(req.Pods) > kube.MaxLogSources {
		badRequest(w, fmt.Sprintf("at most %d pods can be streamed together", kube.MaxLogSources))
		return
	}
	if req.Container != "" && len(validation.IsDNS1123Label(req.Container)) > 0 {
		badRequest(w, "invalid container name")
		return
	}
	var since *time.Time
	if req.Since != "" {
		ts, err := time.Parse(time.RFC3339, req.Since)
		if err != nil {
			badRequest(w, "since must be an RFC 3339 timestamp")
			return
		}
		since = &ts
	}
	tail := req.Tail
	if !(since != nil && tail == 0) && (tail <= 0 || tail > maxTailLines) {
		tail = maxTailLines
	}

	var sources []kube.LogSource
	for _, p := range req.Pods {
		if !validName(p.Ns, p.Pod) || (p.Container != "" && len(validation.IsDNS1123Label(p.Container)) > 0) {
			badRequest(w, "invalid namespace, pod or container name")
			return
		}
		cl, err := s.Kube.Cluster(p.Ctx)
		if err != nil {
			badRequest(w, err.Error())
			return
		}
		sources = append(sources, kube.LogSource{Cluster: cl, CtxID: p.Ctx, Namespace: p.Ns, Pod: p.Pod, Container: p.Container})
	}

	var depCl *kube.Cluster
	var selector string
	if d := req.Deployment; d != nil {
		if !validName(d.Ns, d.Name) {
			badRequest(w, "invalid namespace or deployment name")
			return
		}
		cl, err := s.Kube.Cluster(d.Ctx)
		if err != nil {
			badRequest(w, err.Error())
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		dep, err := cl.Client.AppsV1().Deployments(d.Ns).Get(ctx, d.Name, metav1.GetOptions{})
		cancel()
		if err != nil {
			clusterError(w, err)
			return
		}
		selector = kube.SummarizeDeployment(dep).Selector
		if _, err := labels.Parse(selector); err != nil || selector == "" {
			badRequest(w, "deployment has no usable pod selector")
			return
		}
		depCl = cl
	}

	st := newStream(w, r)
	defer st.close()
	opts := kube.MultiOptions{TailLines: tail, SinceTime: since, NoFollow: req.Follow != nil && !*req.Follow, Previous: req.Previous}
	m := kube.NewMultiLogs(r.Context(), opts, func(e kube.MultiEvent) error { return st.send(e) })

	if depCl == nil {
		for _, src := range sources {
			m.Add(src)
		}
		m.Seal()
	} else {
		d := req.Deployment
		followDeployment(r.Context(), m, depCl, d.Ctx, d.Ns, selector, req.Container, opts.NoFollow)
	}
	if opts.NoFollow {
		m.Wait()
		return
	}
	<-r.Context().Done()
}

// followDeployment keeps the view fed with the deployment's pods. Without
// follow it only takes the pods that exist right now.
func followDeployment(ctx context.Context, m *kube.MultiLogs, cl *kube.Cluster, ctxID, ns, selector, container string, once bool) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pods := map[string]kube.PodSummary{}
	lastInfo := ""

	sync := func() {
		names := make([]string, 0, len(pods))
		for n := range pods {
			names = append(names, n)
		}
		sort.Strings(names)
		waiting, missing := 0, 0
		for _, n := range names {
			p := pods[n]
			c := container
			if c == "" {
				if len(p.Containers) == 0 {
					continue
				}
				c = p.Containers[0]
			} else if !slices.Contains(p.Containers, c) {
				missing++
				continue
			}
			if m.Has(ctxID, ns, n, c) {
				continue
			}
			if !m.Add(kube.LogSource{Cluster: cl, CtxID: ctxID, Namespace: ns, Pod: n, Container: c}) {
				waiting++
			}
		}
		info := ""
		switch {
		case waiting > 0:
			info = fmt.Sprintf("%d more pods are waiting. Up to %d stream at once.", waiting, kube.MaxLogSources)
		case missing > 0:
			info = fmt.Sprintf("%d pods have no %s container.", missing, container)
		}
		if info != lastInfo {
			lastInfo = info
			_ = m.Info(info)
		}
	}

	_ = cl.WatchPods(ctx, ns, selector, func(e kube.WatchEvent) error {
		switch e.Type {
		case "snapshot":
			clear(pods)
			if items, ok := e.Items.([]any); ok {
				for _, it := range items {
					if p, ok := it.(kube.PodSummary); ok {
						pods[p.Name] = p
					}
				}
			}
			sync()
			if once {
				m.Seal()
				cancel()
			}
		case "upsert":
			if p, ok := e.Item.(kube.PodSummary); ok {
				pods[p.Name] = p
				sync()
			}
		case "delete":
			delete(pods, e.Name)
			sync()
		case "status":
			if e.State != "live" && e.Message != "" {
				_ = m.Info("Pod list: " + e.Message)
			}
		}
		return nil
	})
	if once {
		m.Seal()
	}
}
