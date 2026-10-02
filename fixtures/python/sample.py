"""Users by id, cleared on logout."""
import json
from dataclasses import dataclass

MAX_RETRIES = 3
cache_ttl_ms = 60_000


@dataclass
class User:
    id: str
    name: str


class UserRepository:
    """Caches users fetched from the api."""

    def __init__(self, api):
        self._cache: dict[str, User] = {}
        self.is_online = True

    def get_user(self, id: str) -> User | None:
        cached = self._cache.get(id)
        if cached:
            return cached
        try:
            user = self.api.fetch(id)
        except ConnectionError:
            # network failures are expected offline: the caller shows the cached list
            return None
        if not user:
            return None
        self._cache[id] = user
        return user

    def is_cached(self, id: str) -> bool:
        return id in self._cache

    def _evict(self, id):
        del self._cache[id]


def describe(state) -> str:
    """One line for the UI."""
    if state.kind == "loading":
        return "loading"
    elif state.kind == "ready":
        return f"ready: {len(state.items)}"
    else:
        return "failed: {}".format(state.cause)


def to_slug(s):
    return s.lower().replace(" ", "-")


def _first_line(text: str) -> str:
    return text.split("\n")[0].strip()


def active_names(users):
    names = [u.name for u in users if u.is_active]
    try:
        return sorted(names)
    except:
        return names
