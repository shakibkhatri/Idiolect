package sample

import kotlinx.coroutines.flow.Flow

sealed interface LoadState {
    data object Loading : LoadState
    data class Ready(val items: List<String>) : LoadState
    data class Failed(val cause: Throwable) : LoadState
}

class UserRepository(private val api: UserApi) {

    // cache by id, cleared on logout
    private val cache = mutableMapOf<String, User>()

    suspend fun getUser(id: String): User? {
        cache[id]?.let { return it }
        val user = runCatching { api.fetch(id) }.getOrNull() ?: return null
        cache[id] = user
        return user
    }

    fun isCached(id: String): Boolean = id in cache

    fun describe(state: LoadState): String = when (state) {
        LoadState.Loading -> "loading"
        is LoadState.Ready -> "ready: ${state.items.size}"
        is LoadState.Failed -> "failed: ${state.cause.message}"
    }
}

fun String.toSlug(): String = lowercase().replace(' ', '-')
