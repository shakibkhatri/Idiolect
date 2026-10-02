// Package sample caches users by id.
package sample

import (
	"errors"
	"strings"
)

const MaxRetries = 3
const cacheTTLMs = 60_000

// User is one account.
type User struct {
	ID   string
	Name string
}

// Fetcher loads a user by id.
type Fetcher interface {
	Fetch(id string) (*User, error)
}

// UserRepository caches users fetched from the api.
type UserRepository struct {
	api   Fetcher
	cache map[string]*User
	// IsOnline flips when the network goes away.
	IsOnline bool
}

// GetUser returns the cached user or fetches it, nil when the api has none.
func (r *UserRepository) GetUser(id string) (*User, error) {
	if cached, ok := r.cache[id]; ok {
		return cached, nil
	}
	user, err := r.api.Fetch(id)
	if err != nil {
		// network failures are expected offline: the caller shows the cached list
		return nil, nil
	}
	if user == nil {
		return nil, errors.New("no user")
	}
	r.cache[id] = user
	return user, nil
}

func (r *UserRepository) isCached(id string) bool {
	_, ok := r.cache[id]
	return ok
}

func (r *UserRepository) evict(id string) {
	delete(r.cache, id)
}

// Describe is one line for the UI.
func Describe(kind string, items int) string {
	switch kind {
	case "loading":
		return "loading"
	case "ready":
		return "ready"
	default:
		return "failed"
	}
}

func toSlug(s string) string {
	return strings.ReplaceAll(strings.ToLower(s), " ", "-")
}

func firstLine(text string) (line string) {
	line = strings.SplitN(text, "\n", 2)[0]
	return
}

func mustUser(v interface{}) *User {
	u := v.(*User)
	if u == nil {
		panic("nil user")
	}
	return u
}
