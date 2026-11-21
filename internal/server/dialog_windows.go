//go:build windows

package server

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// Fixed script (no user input is interpolated). Uses a TopMost owner so the
// dialog appears above the browser window.
const fileDialogScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = 'Pod Cave - choose a kubeconfig file'
$dlg.Filter = 'All files (*.*)|*.*|YAML (*.yaml;*.yml)|*.yaml;*.yml'
$kube = Join-Path $env:USERPROFILE '.kube'
if (Test-Path $kube) { $dlg.InitialDirectory = $kube }
if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }
$owner.Dispose()
`

func openFileDialog(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", fileDialogScript)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errOut.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New("could not open file dialog: " + msg)
	}
	return strings.TrimSpace(out.String()), nil
}
