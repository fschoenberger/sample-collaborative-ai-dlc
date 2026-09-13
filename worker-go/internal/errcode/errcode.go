// Package errcode attaches stable codes to errors.
//
// The codes are load-bearing, not decoration: the worker loop records
// [Of](err) as a job's failureReason, and callers branch on specific codes.
// An error without one yields "".
package errcode

import "errors"

type coded struct {
	code string
	err  error
}

func (c coded) Error() string { return c.err.Error() }
func (c coded) Unwrap() error { return c.err }
func (c coded) Code() string  { return c.code }

// New returns an error carrying code. Package-level values built with New work
// as sentinels for errors.Is.
func New(code, msg string) error { return coded{code, errors.New(msg)} }

// Wrap tags err with code, preserving it for errors.Is and errors.As.
func Wrap(code string, err error) error { return coded{code, err} }

// Of reports the code of the first error in err's chain that carries one.
func Of(err error) string {
	var c interface{ Code() string }
	if errors.As(err, &c) {
		return c.Code()
	}
	return ""
}
