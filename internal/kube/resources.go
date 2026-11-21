package kube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"sort"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/kubectl/pkg/describe"
	"sigs.k8s.io/yaml"
)

type Owner struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type PodSummary struct {
	Name           string            `json:"name"`
	Namespace      string            `json:"namespace"`
	Status         string            `json:"status"`
	Phase          string            `json:"phase"`
	Ready          string            `json:"ready"`
	Restarts       int32             `json:"restarts"`
	Created        time.Time         `json:"created"`
	Node           string            `json:"node,omitempty"`
	IP             string            `json:"ip,omitempty"`
	Containers     []string          `json:"containers"`
	InitContainers []string          `json:"initContainers,omitempty"`
	Owner          *Owner            `json:"owner,omitempty"`
	Labels         map[string]string `json:"labels,omitempty"`
}

type DeploymentSummary struct {
	Name      string    `json:"name"`
	Namespace string    `json:"namespace"`
	Replicas  int32     `json:"replicas"`
	Ready     int32     `json:"ready"`
	UpToDate  int32     `json:"upToDate"`
	Available int32     `json:"available"`
	Created   time.Time `json:"created"`
	Images    []string  `json:"images"`
	Selector  string    `json:"selector"`
	Paused    bool      `json:"paused,omitempty"`
	Message   string    `json:"message,omitempty"`
}

// podStatus mirrors the STATUS column of `kubectl get pods`.
func podStatus(p *corev1.Pod) (status string, readyCount, total int, restarts int32) {
	total = len(p.Spec.Containers)
	status = string(p.Status.Phase)
	if p.Status.Reason != "" {
		status = p.Status.Reason
	}
	initializing := false
	for i, c := range p.Status.InitContainerStatuses {
		restarts += c.RestartCount
		switch {
		case c.State.Terminated != nil && c.State.Terminated.ExitCode == 0:
			continue
		case c.State.Terminated != nil:
			if c.State.Terminated.Reason != "" {
				status = "Init:" + c.State.Terminated.Reason
			} else if c.State.Terminated.Signal != 0 {
				status = fmt.Sprintf("Init:Signal:%d", c.State.Terminated.Signal)
			} else {
				status = fmt.Sprintf("Init:ExitCode:%d", c.State.Terminated.ExitCode)
			}
		case c.State.Waiting != nil && c.State.Waiting.Reason != "" && c.State.Waiting.Reason != "PodInitializing":
			status = "Init:" + c.State.Waiting.Reason
		case c.State.Running != nil && isSidecar(p, c.Name):
			continue
		default:
			status = fmt.Sprintf("Init:%d/%d", i, len(p.Spec.InitContainers))
		}
		initializing = true
		break
	}
	if !initializing {
		hasRunning := false
		for i := len(p.Status.ContainerStatuses) - 1; i >= 0; i-- {
			c := p.Status.ContainerStatuses[i]
			restarts += c.RestartCount
			switch {
			case c.State.Waiting != nil && c.State.Waiting.Reason != "":
				status = c.State.Waiting.Reason
			case c.State.Terminated != nil && c.State.Terminated.Reason != "":
				status = c.State.Terminated.Reason
			case c.State.Terminated != nil && c.State.Terminated.Signal != 0:
				status = fmt.Sprintf("Signal:%d", c.State.Terminated.Signal)
			case c.State.Terminated != nil:
				status = fmt.Sprintf("ExitCode:%d", c.State.Terminated.ExitCode)
			case c.Ready && c.State.Running != nil:
				hasRunning = true
				readyCount++
			}
		}
		if status == "Completed" && hasRunning {
			status = "Running"
			for _, cond := range p.Status.Conditions {
				if cond.Type == corev1.PodReady && cond.Status != corev1.ConditionTrue {
					status = "NotReady"
				}
			}
		}
	}
	if p.DeletionTimestamp != nil {
		if p.Status.Reason == "NodeLost" {
			status = "Unknown"
		} else {
			status = "Terminating"
		}
	}
	return status, readyCount, total, restarts
}

func isSidecar(p *corev1.Pod, name string) bool {
	for _, c := range p.Spec.InitContainers {
		if c.Name == name {
			return c.RestartPolicy != nil && *c.RestartPolicy == corev1.ContainerRestartPolicyAlways
		}
	}
	return false
}

func SummarizePod(p *corev1.Pod) PodSummary {
	status, ready, total, restarts := podStatus(p)
	s := PodSummary{
		Name: p.Name, Namespace: p.Namespace, Status: status, Phase: string(p.Status.Phase),
		Ready: fmt.Sprintf("%d/%d", ready, total), Restarts: restarts, Created: p.CreationTimestamp.Time,
		Node: p.Spec.NodeName, IP: p.Status.PodIP, Labels: p.Labels,
	}
	for _, c := range p.Spec.Containers {
		s.Containers = append(s.Containers, c.Name)
	}
	for _, c := range p.Spec.InitContainers {
		s.InitContainers = append(s.InitContainers, c.Name)
	}
	if ref := metav1.GetControllerOf(p); ref != nil {
		s.Owner = &Owner{Kind: ref.Kind, Name: ref.Name}
	}
	return s
}

func SummarizeDeployment(d *appsv1.Deployment) DeploymentSummary {
	s := DeploymentSummary{
		Name: d.Name, Namespace: d.Namespace, Ready: d.Status.ReadyReplicas, UpToDate: d.Status.UpdatedReplicas,
		Available: d.Status.AvailableReplicas, Created: d.CreationTimestamp.Time, Paused: d.Spec.Paused,
	}
	s.Replicas = 1
	if d.Spec.Replicas != nil {
		s.Replicas = *d.Spec.Replicas
	}
	for _, c := range d.Spec.Template.Spec.Containers {
		s.Images = append(s.Images, c.Image)
	}
	if sel, err := metav1.LabelSelectorAsSelector(d.Spec.Selector); err == nil {
		s.Selector = sel.String()
	}
	for _, c := range d.Status.Conditions {
		if c.Status != corev1.ConditionTrue && c.Message != "" {
			s.Message = c.Message
		}
	}
	return s
}

type Namespaces struct {
	Items      []string `json:"items"`
	Restricted bool     `json:"restricted"`
	Message    string   `json:"message,omitempty"`
}

func (c *Cluster) Namespaces(ctx context.Context) (Namespaces, error) {
	list, err := c.Client.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if apierrors.IsForbidden(err) {
		return Namespaces{Items: []string{c.Info.Namespace}, Restricted: true,
			Message: "You are not allowed to list namespaces in this cluster. Add the namespaces you can access manually."}, nil
	}
	if err != nil {
		return Namespaces{}, err
	}
	out := Namespaces{}
	for _, ns := range list.Items {
		out.Items = append(out.Items, ns.Name)
	}
	sort.Strings(out.Items)
	return out, nil
}

// WatchEvent is streamed to the UI as NDJSON.
type WatchEvent struct {
	Type    string `json:"type"` // snapshot | upsert | delete | status
	Items   any    `json:"items,omitempty"`
	Item    any    `json:"item,omitempty"`
	Name    string `json:"name,omitempty"`
	State   string `json:"state,omitempty"` // live | reconnecting | error | auth
	Message string `json:"message,omitempty"`
}

type watchSpec struct {
	list      func(ctx context.Context, opts metav1.ListOptions) (items []runtime.Object, rv string, err error)
	watch     func(ctx context.Context, opts metav1.ListOptions) (watch.Interface, error)
	summarize func(obj runtime.Object) (name string, item any, ok bool)
}

func (c *Cluster) WatchPods(ctx context.Context, ns, selector string, emit func(WatchEvent) error) error {
	pods := c.Client.CoreV1().Pods(ns)
	return runWatch(ctx, emit, watchSpec{
		list: func(ctx context.Context, o metav1.ListOptions) ([]runtime.Object, string, error) {
			o.LabelSelector = selector
			l, err := pods.List(ctx, o)
			if err != nil {
				return nil, "", err
			}
			objs := make([]runtime.Object, len(l.Items))
			for i := range l.Items {
				objs[i] = &l.Items[i]
			}
			return objs, l.ResourceVersion, nil
		},
		watch: func(ctx context.Context, o metav1.ListOptions) (watch.Interface, error) {
			o.LabelSelector = selector
			return pods.Watch(ctx, o)
		},
		summarize: func(obj runtime.Object) (string, any, bool) {
			p, ok := obj.(*corev1.Pod)
			if !ok {
				return "", nil, false
			}
			return p.Name, SummarizePod(p), true
		},
	})
}

func (c *Cluster) WatchDeployments(ctx context.Context, ns string, emit func(WatchEvent) error) error {
	deps := c.Client.AppsV1().Deployments(ns)
	return runWatch(ctx, emit, watchSpec{
		list: func(ctx context.Context, o metav1.ListOptions) ([]runtime.Object, string, error) {
			l, err := deps.List(ctx, o)
			if err != nil {
				return nil, "", err
			}
			objs := make([]runtime.Object, len(l.Items))
			for i := range l.Items {
				objs[i] = &l.Items[i]
			}
			return objs, l.ResourceVersion, nil
		},
		watch: deps.Watch,
		summarize: func(obj runtime.Object) (string, any, bool) {
			d, ok := obj.(*appsv1.Deployment)
			if !ok {
				return "", nil, false
			}
			return d.Name, SummarizeDeployment(d), true
		},
	})
}

// runWatch lists, then watches, transparently re-watching on disconnects and
// re-listing when the resourceVersion expires (410 Gone). It only returns when
// ctx is cancelled or emit fails (client went away).
func runWatch(ctx context.Context, emit func(WatchEvent) error, spec watchSpec) error {
	backoff := time.Second
	sleep := func() bool {
		d := backoff + time.Duration(rand.Int64N(int64(backoff/2)+1))
		if backoff < 30*time.Second {
			backoff *= 2
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(d):
			return true
		}
	}
	status := func(err error) error {
		state := "reconnecting"
		if IsAuthError(err) || apierrors.IsUnauthorized(err) {
			state = "auth"
		} else if apierrors.IsForbidden(err) || apierrors.IsNotFound(err) || apierrors.IsBadRequest(err) {
			state = "error"
		}
		return emit(WatchEvent{Type: "status", State: state, Message: cleanErr(err)})
	}

	for ctx.Err() == nil {
		objs, rv, err := spec.list(ctx, metav1.ListOptions{})
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if e := status(err); e != nil {
				return e
			}
			if !sleep() {
				return nil
			}
			continue
		}
		items := make([]any, 0, len(objs))
		for _, o := range objs {
			if _, it, ok := spec.summarize(o); ok {
				items = append(items, it)
			}
		}
		if err := emit(WatchEvent{Type: "snapshot", Items: items}); err != nil {
			return err
		}
		if err := emit(WatchEvent{Type: "status", State: "live"}); err != nil {
			return err
		}
		backoff = time.Second

	watchLoop:
		for ctx.Err() == nil {
			timeout := int64(240 + rand.IntN(120))
			w, err := spec.watch(ctx, metav1.ListOptions{ResourceVersion: rv, AllowWatchBookmarks: true, TimeoutSeconds: &timeout})
			if err != nil {
				if apierrors.IsResourceExpired(err) || apierrors.IsGone(err) {
					break watchLoop
				}
				if ctx.Err() != nil {
					return nil
				}
				if e := status(err); e != nil {
					return e
				}
				if !sleep() {
					return nil
				}
				continue
			}
			for ev := range w.ResultChan() {
				switch ev.Type {
				case watch.Added, watch.Modified, watch.Deleted:
					if m, err := metaAccessor(ev.Object); err == nil {
						rv = m.GetResourceVersion()
					}
					name, it, ok := spec.summarize(ev.Object)
					if !ok {
						continue
					}
					e := WatchEvent{Type: "upsert", Item: it}
					if ev.Type == watch.Deleted {
						e = WatchEvent{Type: "delete", Name: name}
					}
					if err := emit(e); err != nil {
						w.Stop()
						return err
					}
					backoff = time.Second
				case watch.Bookmark:
					if m, err := metaAccessor(ev.Object); err == nil {
						rv = m.GetResourceVersion()
					}
				case watch.Error:
					w.Stop()
					se := apierrors.FromObject(ev.Object)
					if apierrors.IsResourceExpired(se) || apierrors.IsGone(se) {
						break watchLoop
					}
					if e := status(se); e != nil {
						return e
					}
					if !sleep() {
						return nil
					}
					continue watchLoop
				}
			}
			w.Stop()
		}
	}
	return nil
}

func metaAccessor(obj runtime.Object) (metav1.Object, error) {
	if m, ok := obj.(metav1.Object); ok {
		return m, nil
	}
	return nil, errors.New("no metadata")
}

func groupKind(kind string) (schema.GroupKind, error) {
	switch kind {
	case "pod":
		return schema.GroupKind{Kind: "Pod"}, nil
	case "deployment":
		return schema.GroupKind{Group: "apps", Kind: "Deployment"}, nil
	}
	return schema.GroupKind{}, errors.New("unsupported kind")
}

// Describe returns the same text as `kubectl describe`.
func (c *Cluster) Describe(kind, ns, name string) (string, error) {
	gk, err := groupKind(kind)
	if err != nil {
		return "", err
	}
	d, ok := describe.DescriberFor(gk, c.Rest)
	if !ok {
		return "", errors.New("no describer available")
	}
	return d.Describe(ns, name, describe.DescriberSettings{ShowEvents: true, ChunkSize: 500})
}

// YAML returns the live object without noisy managedFields.
func (c *Cluster) YAML(ctx context.Context, kind, ns, name string) (string, error) {
	var obj runtime.Object
	switch kind {
	case "pod":
		p, err := c.Client.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return "", err
		}
		p.ManagedFields = nil
		p.APIVersion, p.Kind = "v1", "Pod"
		obj = p
	case "deployment":
		d, err := c.Client.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return "", err
		}
		d.ManagedFields = nil
		d.APIVersion, d.Kind = "apps/v1", "Deployment"
		obj = d
	default:
		return "", errors.New("unsupported kind")
	}
	b, err := yaml.Marshal(obj)
	return string(b), err
}

func (c *Cluster) DeletePod(ctx context.Context, ns, name string) error {
	return c.Client.CoreV1().Pods(ns).Delete(ctx, name, metav1.DeleteOptions{})
}

// RestartDeployment does the same as `kubectl rollout restart`.
func (c *Cluster) RestartDeployment(ctx context.Context, ns, name string) error {
	patch, _ := json.Marshal(map[string]any{"spec": map[string]any{"template": map[string]any{"metadata": map[string]any{
		"annotations": map[string]string{"kubectl.kubernetes.io/restartedAt": time.Now().Format(time.RFC3339)},
	}}}})
	_, err := c.Client.AppsV1().Deployments(ns).Patch(ctx, name, types.StrategicMergePatchType, patch, metav1.PatchOptions{FieldManager: "pod-cave"})
	return err
}

func (c *Cluster) ScaleDeployment(ctx context.Context, ns, name string, replicas int32) error {
	patch, _ := json.Marshal(map[string]any{"spec": map[string]any{"replicas": replicas}})
	_, err := c.Client.AppsV1().Deployments(ns).Patch(ctx, name, types.MergePatchType, patch, metav1.PatchOptions{FieldManager: "pod-cave"}, "scale")
	return err
}

// cleanErr shortens client-go errors for display.
func cleanErr(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	var ae *AuthError
	if errors.As(err, &ae) {
		msg = ae.Msg
	}
	if len(msg) > 600 {
		msg = msg[:600] + "…"
	}
	return strings.TrimSpace(msg)
}

func CleanErr(err error) string { return cleanErr(err) }
