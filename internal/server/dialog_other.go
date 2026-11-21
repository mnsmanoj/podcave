//go:build !windows

package server

import (
	"context"
	"errors"
)

func openFileDialog(context.Context) (string, error) {
	return "", errors.New("native file dialog is only available on Windows; paste the file path instead")
}
