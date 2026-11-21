//go:build windows

package store

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

var entropy = []byte("PodCave/kubeconfig/v1")

const protectEncrypts = true

// protect encrypts data with DPAPI so only the current Windows user can decrypt it.
func protect(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty data")
	}
	in := blob(data)
	ent := blob(entropy)
	var out windows.DataBlob
	desc, _ := windows.UTF16PtrFromString("Pod Cave kubeconfig")
	if err := windows.CryptProtectData(&in, desc, &ent, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	return takeBlob(&out), nil
}

func unprotect(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty data")
	}
	in := blob(data)
	ent := blob(entropy)
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, &ent, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	return takeBlob(&out), nil
}

func blob(b []byte) windows.DataBlob {
	return windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
}

func takeBlob(b *windows.DataBlob) []byte {
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(b.Data)))
	return append([]byte(nil), unsafe.Slice(b.Data, b.Size)...)
}
