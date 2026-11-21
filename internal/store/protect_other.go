//go:build !windows

package store

// On non-Windows systems imported kubeconfigs rely on 0600 file permissions
// inside a 0700 directory (same protection as ~/.kube/config).
const protectEncrypts = false

func protect(data []byte) ([]byte, error)   { return append([]byte(nil), data...), nil }
func unprotect(data []byte) ([]byte, error) { return append([]byte(nil), data...), nil }
