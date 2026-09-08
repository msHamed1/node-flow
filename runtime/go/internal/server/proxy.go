package server

import (
	"fmt"
	"net/http/httputil"
	"net/url"
)

func NewTopologyProxy(rawURL string) (*httputil.ReverseProxy, error) {
	target, err := url.Parse(rawURL)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
		return nil, fmt.Errorf("invalid topology proxy URL %q", rawURL)
	}
	return httputil.NewSingleHostReverseProxy(target), nil
}
