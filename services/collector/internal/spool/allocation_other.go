//go:build !linux && !darwin && !freebsd && !netbsd && !openbsd

package spool

import "os"

func allocatedFileBytes(info os.FileInfo) int64 { return info.Size() }
