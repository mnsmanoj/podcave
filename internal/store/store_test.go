package store

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

const sampleKubeconfig = "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers:\n- name: u\n  user:\n    token: super-secret-token\n"

func TestImportedKubeconfigIsEncryptedAndPersisted(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	src, err := s.AddImported("prod", []byte(sampleKubeconfig))
	if err != nil {
		t.Fatal(err)
	}
	onDisk, err := os.ReadFile(filepath.Join(dir, "kubeconfigs", src.ID+".kc"))
	if err != nil {
		t.Fatal(err)
	}
	if protectEncrypts && bytes.Contains(onDisk, []byte("super-secret-token")) {
		t.Fatal("imported kubeconfig stored in plaintext")
	}

	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := reopened.Source(src.ID)
	if !ok {
		t.Fatal("source not persisted")
	}
	data, err := reopened.Read(got)
	if err != nil || string(data) != sampleKubeconfig {
		t.Fatalf("round trip failed: %v", err)
	}
	if err := reopened.Remove(src.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "kubeconfigs", src.ID+".kc")); !os.IsNotExist(err) {
		t.Fatal("removing an imported kubeconfig must delete its encrypted file")
	}
}

func TestLinkedFileIsReferencedNotCopied(t *testing.T) {
	dir := t.TempDir()
	kc := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(kc, []byte(sampleKubeconfig), 0o600); err != nil {
		t.Fatal(err)
	}
	s, _ := Open(dir)
	if _, err := s.AddFile("", kc); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddFile("", kc); err == nil {
		t.Fatal("duplicate file should be rejected")
	}
	if _, err := s.AddFile("", "relative/config"); err == nil {
		t.Fatal("relative path should be rejected")
	}
	cfg, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	if bytes.Contains(cfg, []byte("super-secret-token")) {
		t.Fatal("linked kubeconfig contents leaked into settings")
	}
}

func TestPrefsMustBeObject(t *testing.T) {
	s, _ := Open(t.TempDir())
	if err := s.SetPrefs([]byte(`[1,2]`)); err == nil {
		t.Fatal("non-object prefs accepted")
	}
	if err := s.SetPrefs([]byte(`{"lastContext":"a/b"}`)); err != nil {
		t.Fatal(err)
	}
	if string(s.Prefs()) != `{"lastContext":"a/b"}` {
		t.Fatal("prefs not stored")
	}
}
