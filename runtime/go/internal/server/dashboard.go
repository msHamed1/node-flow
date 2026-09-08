package server

import (
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func dashboardHandler(directory string) http.Handler {
	root := os.DirFS(directory)
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		name := strings.TrimPrefix(filepath.ToSlash(filepath.Clean(request.URL.Path)), "/")
		if name == "." || name == "" {
			name = "index.html"
		}
		if info, err := fs.Stat(root, name); err == nil && !info.IsDir() {
			http.ServeFileFS(response, request, root, name)
			return
		}
		if _, err := fs.Stat(root, "index.html"); err == nil {
			http.ServeFileFS(response, request, root, "index.html")
			return
		} else if !errors.Is(err, fs.ErrNotExist) {
			http.Error(response, "dashboard unavailable", http.StatusInternalServerError)
			return
		}
		http.Error(response, "dashboard is not built", http.StatusNotFound)
	})
}
