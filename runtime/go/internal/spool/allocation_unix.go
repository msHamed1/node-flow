//go:build linux || darwin || freebsd || netbsd || openbsd

package spool

import (
	"os"
	"syscall"
)

func allocatedFileBytes(info os.FileInfo) int64 {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && stat.Blocks > 0 {
		return stat.Blocks * 512
	}
	return info.Size()
}
