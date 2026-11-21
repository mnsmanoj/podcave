//go:build !windows

package kube

import "os/exec"

func hideWindow(*exec.Cmd) {}
