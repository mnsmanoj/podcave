// Package store persists Pod Cave settings: the list of kubeconfig sources and
// opaque UI preferences. Imported kubeconfig contents are encrypted at rest.
package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	KindFile     = "file"
	KindImported = "imported"

	MaxKubeconfigBytes = 1 << 20
	MaxPrefsBytes      = 64 << 10
	maxSources         = 50
	maxNameLen         = 80
)

type Source struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Kind    string    `json:"kind"`
	Path    string    `json:"path,omitempty"`
	AddedAt time.Time `json:"addedAt"`
}

type config struct {
	Version int             `json:"version"`
	Sources []Source        `json:"sources"`
	Prefs   json.RawMessage `json:"prefs,omitempty"`
}

type Store struct {
	mu  sync.Mutex
	dir string
	cfg config
}

// DefaultDir returns %APPDATA%\PodCave (or the OS equivalent).
func DefaultDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "PodCave"), nil
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "kubeconfigs"), 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, cfg: config{Version: 1}}
	data, err := os.ReadFile(s.configPath())
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(data, &s.cfg); err != nil {
			return nil, fmt.Errorf("settings file %s is corrupt: %w", s.configPath(), err)
		}
	}
	return s, nil
}

func (s *Store) Dir() string { return s.dir }

func (s *Store) configPath() string { return filepath.Join(s.dir, "config.json") }

func (s *Store) importedPath(id string) string {
	return filepath.Join(s.dir, "kubeconfigs", id+".kc")
}

func (s *Store) Sources() []Source {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Source(nil), s.cfg.Sources...)
}

func (s *Store) Source(id string) (Source, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, src := range s.cfg.Sources {
		if src.ID == id {
			return src, true
		}
	}
	return Source{}, false
}

// AddFile links a kubeconfig file in place; its contents are never copied.
func (s *Store) AddFile(name, path string) (Source, error) {
	path = filepath.Clean(strings.TrimSpace(path))
	if !filepath.IsAbs(path) {
		return Source{}, errors.New("path must be absolute")
	}
	if _, err := ReadKubeconfigFile(path); err != nil {
		return Source{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, src := range s.cfg.Sources {
		if src.Kind == KindFile && strings.EqualFold(src.Path, path) {
			return Source{}, errors.New("this kubeconfig file is already added")
		}
	}
	if name == "" {
		name = filepath.Base(path)
	}
	src, err := s.newSourceLocked(name, KindFile)
	if err != nil {
		return Source{}, err
	}
	src.Path = path
	return src, s.appendLocked(src)
}

// AddImported stores a copy of kubeconfig contents, encrypted for the current OS user.
func (s *Store) AddImported(name string, data []byte) (Source, error) {
	if len(data) == 0 || len(data) > MaxKubeconfigBytes {
		return Source{}, errors.New("kubeconfig must be between 1 byte and 1 MiB")
	}
	enc, err := protect(data)
	if err != nil {
		return Source{}, fmt.Errorf("encrypting kubeconfig: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if name == "" {
		name = "imported kubeconfig"
	}
	src, err := s.newSourceLocked(name, KindImported)
	if err != nil {
		return Source{}, err
	}
	if err := writeFileAtomic(s.importedPath(src.ID), enc); err != nil {
		return Source{}, err
	}
	if err := s.appendLocked(src); err != nil {
		_ = os.Remove(s.importedPath(src.ID))
		return Source{}, err
	}
	return src, nil
}

func (s *Store) newSourceLocked(name, kind string) (Source, error) {
	if len(s.cfg.Sources) >= maxSources {
		return Source{}, fmt.Errorf("at most %d kubeconfigs can be added", maxSources)
	}
	name, err := cleanName(name)
	if err != nil {
		return Source{}, err
	}
	return Source{ID: randomID(), Name: name, Kind: kind, AddedAt: time.Now().UTC()}, nil
}

func (s *Store) appendLocked(src Source) error {
	next := s.cfg
	next.Sources = append(append([]Source(nil), s.cfg.Sources...), src)
	if err := s.saveLocked(next); err != nil {
		return err
	}
	s.cfg = next
	return nil
}

func (s *Store) Rename(id, name string) error {
	name, err := cleanName(name)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.cfg
	next.Sources = append([]Source(nil), s.cfg.Sources...)
	for i := range next.Sources {
		if next.Sources[i].ID == id {
			next.Sources[i].Name = name
			if err := s.saveLocked(next); err != nil {
				return err
			}
			s.cfg = next
			return nil
		}
	}
	return errors.New("kubeconfig not found")
}

func (s *Store) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.cfg
	next.Sources = nil
	var removed *Source
	for _, src := range s.cfg.Sources {
		if src.ID == id {
			src := src
			removed = &src
			continue
		}
		next.Sources = append(next.Sources, src)
	}
	if removed == nil {
		return errors.New("kubeconfig not found")
	}
	if err := s.saveLocked(next); err != nil {
		return err
	}
	s.cfg = next
	if removed.Kind == KindImported {
		if err := os.Remove(s.importedPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Read returns the kubeconfig bytes for a source.
func (s *Store) Read(src Source) ([]byte, error) {
	switch src.Kind {
	case KindFile:
		return ReadKubeconfigFile(src.Path)
	case KindImported:
		enc, err := os.ReadFile(s.importedPath(src.ID))
		if err != nil {
			return nil, err
		}
		return unprotect(enc)
	default:
		return nil, fmt.Errorf("unknown source kind %q", src.Kind)
	}
}

func (s *Store) Prefs() json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.cfg.Prefs) == 0 {
		return json.RawMessage("{}")
	}
	return append(json.RawMessage(nil), s.cfg.Prefs...)
}

func (s *Store) SetPrefs(p json.RawMessage) error {
	if len(p) > MaxPrefsBytes {
		return errors.New("preferences too large")
	}
	var obj map[string]any
	if err := json.Unmarshal(p, &obj); err != nil || obj == nil {
		return errors.New("preferences must be a JSON object")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.cfg
	next.Prefs = append(json.RawMessage(nil), p...)
	if err := s.saveLocked(next); err != nil {
		return err
	}
	s.cfg = next
	return nil
}

func (s *Store) saveLocked(c config) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(s.configPath(), data)
}

// ReadKubeconfigFile reads a linked kubeconfig with basic sanity checks.
func ReadKubeconfigFile(path string) ([]byte, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	if fi.Size() > MaxKubeconfigBytes {
		return nil, errors.New("file is larger than 1 MiB; this does not look like a kubeconfig")
	}
	return os.ReadFile(path)
}

// FileModTime is used to detect when a linked kubeconfig changed on disk
// (for example after `az aks get-credentials`).
func FileModTime(path string) time.Time {
	fi, err := os.Stat(path)
	if err != nil {
		return time.Time{}
	}
	return fi.ModTime()
}

func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("name is required")
	}
	if len([]rune(name)) > maxNameLen {
		return "", fmt.Errorf("name must be at most %d characters", maxNameLen)
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", errors.New("name contains control characters")
		}
	}
	return name, nil
}

func randomID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
