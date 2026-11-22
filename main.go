package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"podcave/internal/events"
	"podcave/internal/kube"
	"podcave/internal/server"
	"podcave/internal/store"
	"podcave/web"
)

var version = "dev"

const banner = `
        __        /\ /\        __
    _.-'  '-.__  /  V  \  __.-'  '-._
   /          '-\ o   o /-'          \      P O D   C A V E
  /_    _    _   \  ^  /   _    _    _\     local Kubernetes dashboard
    '--' '--' '--.\   /.--' '--' '--'
                  '-'
`

func main() {
	port := flag.Int("port", 0, "port to listen on (127.0.0.1 only); 0 picks a random free port")
	noBrowser := flag.Bool("no-browser", false, "do not open the browser automatically")
	dataDir := flag.String("data-dir", "", "settings directory (default %APPDATA%\\PodCave)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("pod-cave", version)
		return
	}
	if err := run(*port, *noBrowser, *dataDir); err != nil {
		fmt.Fprintln(os.Stderr, "pod-cave:", err)
		if runtime.GOOS == "windows" {
			fmt.Fprintln(os.Stderr, "Press Enter to exit.")
			_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		}
		os.Exit(1)
	}
}

func run(port int, noBrowser bool, dataDir string) error {
	if dataDir == "" {
		d, err := store.DefaultDir()
		if err != nil {
			return err
		}
		dataDir = d
	}
	st, err := store.Open(dataDir)
	if err != nil {
		return err
	}
	hub := events.NewHub()
	srv := &server.Server{Version: version, Store: st, Kube: kube.NewManager(st, hub, version), Hub: hub, Web: web.FS()}
	if err := srv.Listen(port); err != nil {
		return fmt.Errorf("cannot listen on 127.0.0.1:%d: %w", port, err)
	}

	fmt.Print(banner)
	fmt.Printf("  Version  %s\n  Settings %s\n  Listening on 127.0.0.1:%d (this computer only)\n\n", version, dataDir, srv.Port())
	open := func() {
		url := srv.LaunchURL()
		fmt.Println("  Sign-in link (single use, valid 10 minutes):")
		fmt.Println("  " + url)
		fmt.Println()
		if !noBrowser {
			if err := openBrowser(url); err != nil {
				fmt.Println("  Could not open the browser automatically; copy the link above.")
			}
		}
	}
	open()
	fmt.Println("  Press Enter for a new sign-in link / new tab.  Type q + Enter (or Ctrl+C) to quit.")

	quit := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			if strings.EqualFold(strings.TrimSpace(sc.Text()), "q") {
				close(quit)
				return
			}
			open()
		}
	}()

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve() }()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-sig:
	case <-quit:
	}
	fmt.Println("\n  Leaving the cave. Goodbye.")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	return nil
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}
