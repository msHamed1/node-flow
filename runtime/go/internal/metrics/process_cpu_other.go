//go:build !linux && !darwin

package metrics

func processCPUSeconds() float64 { return 0 }
