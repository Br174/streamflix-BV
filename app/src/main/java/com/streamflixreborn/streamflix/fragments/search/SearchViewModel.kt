package com.streamflixreborn.streamflix.fragments.search

import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.streamflixreborn.streamflix.adapters.AppAdapter
import com.streamflixreborn.streamflix.database.AppDatabase
import com.streamflixreborn.streamflix.models.Movie
import com.streamflixreborn.streamflix.models.TvShow
import com.streamflixreborn.streamflix.providers.AdvancedSearchFilters
import com.streamflixreborn.streamflix.providers.IptvProvider
import com.streamflixreborn.streamflix.providers.Provider
import com.streamflixreborn.streamflix.providers.TmdbProvider
import com.streamflixreborn.streamflix.utils.ParentalControlUtils
import com.streamflixreborn.streamflix.utils.TMDb3
import com.streamflixreborn.streamflix.utils.TMDb3.original
import com.streamflixreborn.streamflix.utils.TMDb3.w500
import com.streamflixreborn.streamflix.utils.UserPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.transformLatest
import kotlinx.coroutines.launch

sealed class State {
    data object Searching : State()
    data object SearchingMore : State()
    data class SuccessSearching(val results: List<AppAdapter.Item>, val hasMore: Boolean) : State()
    data class FailedSearching(val error: Exception) : State()
    data object GlobalSearching : State()
    data class SuccessGlobalSearching(val providerResults: List<ProviderResult>) : State()
}

data class ProviderResult(
    val provider: Provider,
    val state: State,
) {
    sealed class State {
        data object Loading : State()
        data class Success(val results: List<AppAdapter.Item>) : State()
        data class Error(val error: Exception) : State()
    }
}

class SearchViewModel(database: AppDatabase) : ViewModel() {

    private val _state = MutableStateFlow<State>(State.Searching)

    @OptIn(ExperimentalCoroutinesApi::class)
    val state: Flow<State> = combine(
        _state,
        _state.transformLatest { state ->
            when (state) {
                is State.SuccessSearching -> {
                    val movies = state.results.filterIsInstance<Movie>()
                    if (movies.isEmpty()) emit(emptyList())
                    else emitAll(database.movieDao().getByIds(movies.map { it.id }))
                }
                else -> emit(emptyList<Movie>())
            }
        },
        _state.transformLatest { state ->
            when (state) {
                is State.SuccessSearching -> {
                    val tvShows = state.results.filterIsInstance<TvShow>()
                    if (tvShows.isEmpty()) emit(emptyList())
                    else emitAll(database.tvShowDao().getByIds(tvShows.map { it.id }))
                }
                else -> emit(emptyList<TvShow>())
            }
        },
    ) { state, moviesDb, tvShowsDb ->
        when (state) {
            is State.SuccessSearching -> {
                val moviesById = moviesDb.associateBy { it.id }
                val tvShowsById = tvShowsDb.associateBy { it.id }
                State.SuccessSearching(
                    results = state.results.map { item ->
                        when (item) {
                            is Movie -> moviesById[item.id]
                                ?.takeIf { !item.isSame(it) }
                                ?.let { item.copy().merge(it) }
                                ?: item
                            is TvShow -> tvShowsById[item.id]
                                ?.takeIf { !item.isSame(it) }
                                ?.let { item.copy().merge(it) }
                                ?: item
                            else -> item
                        }
                    },
                    hasMore = state.hasMore,
                )
            }
            else -> state
        }
    }.flowOn(Dispatchers.IO)

    var query = ""
    var advancedFilters = AdvancedSearchFilters()
        private set
    private var page = 1

    init {
        search(query)
    }

    fun search(query: String) = viewModelScope.launch(Dispatchers.IO) {
        advancedFilters = AdvancedSearchFilters()
        executeSearch(query, advancedFilters, 1)
    }

    fun searchAdvanced(query: String, filters: AdvancedSearchFilters) =
        viewModelScope.launch(Dispatchers.IO) {
            advancedFilters = normalizeFilters(filters)
            executeSearch(query, advancedFilters, 1)
        }

    private suspend fun executeSearch(
        query: String,
        filters: AdvancedSearchFilters,
        targetPage: Int,
    ) {
        _state.emit(State.Searching)
        try {
            val provider = UserPreferences.currentProvider!!
            val results = if (filters.isActive && provider is TmdbProvider) {
                searchTmdbAdvanced(provider, query, filters, targetPage)
            } else {
                provider.search(query, targetPage)
            }

            this@SearchViewModel.query = query
            page = targetPage
            val filtered = ParentalControlUtils.filterItems(results)
            _state.emit(State.SuccessSearching(filtered, filtered.isNotEmpty()))
        } catch (e: Exception) {
            Log.e("SearchViewModel", "executeSearch: ", e)
            _state.emit(State.FailedSearching(e))
        }
    }

    fun loadMore() = viewModelScope.launch(Dispatchers.IO) {
        val currentState = _state.value
        if (currentState is State.SuccessSearching) {
            _state.emit(State.SearchingMore)
            try {
                val provider = UserPreferences.currentProvider!!
                val nextPage = page + 1
                val results = if (advancedFilters.isActive && provider is TmdbProvider) {
                    searchTmdbAdvanced(provider, query, advancedFilters, nextPage)
                } else {
                    provider.search(query, nextPage)
                }

                val filtered = ParentalControlUtils.filterItems(results)
                val existingKeys = currentState.results
                    .asSequence()
                    .map { it.searchIdentityKey() }
                    .toHashSet()
                val newUniqueResults = filtered.filterNot { it.searchIdentityKey() in existingKeys }
                page = nextPage
                _state.emit(
                    State.SuccessSearching(
                        results = currentState.results + newUniqueResults,
                        hasMore = newUniqueResults.isNotEmpty(),
                    )
                )
            } catch (e: Exception) {
                Log.e("SearchViewModel", "loadMore: ", e)
                _state.emit(State.FailedSearching(e))
            }
        }
    }

    private fun normalizeFilters(filters: AdvancedSearchFilters): AdvancedSearchFilters {
        val hasRange = !filters.dateFrom.isNullOrBlank() || !filters.dateTo.isNullOrBlank()
        return if (hasRange) filters.copy(year = null) else filters
    }

    private suspend fun searchTmdbAdvanced(
        provider: TmdbProvider,
        query: String,
        filters: AdvancedSearchFilters,
        page: Int,
    ): List<AppAdapter.Item> = coroutineScope {
        val includeMovies = filters.type == AdvancedSearchFilters.ContentType.ALL ||
            filters.type == AdvancedSearchFilters.ContentType.MOVIE ||
            filters.type == AdvancedSearchFilters.ContentType.CARTOON
        val includeTv = filters.type == AdvancedSearchFilters.ContentType.ALL ||
            filters.type == AdvancedSearchFilters.ContentType.TV ||
            filters.type == AdvancedSearchFilters.ContentType.CARTOON

        val language = provider.language
        val italianOnly = filters.italian == AdvancedSearchFilters.ItalianFilter.YES
        val excludeItalian = filters.italian == AdvancedSearchFilters.ItalianFilter.NO
        val cartoonOnly = filters.type == AdvancedSearchFilters.ContentType.CARTOON

        val movieDeferred = if (includeMovies) async {
            val params = mutableMapOf(
                "language" to language,
                "page" to page.toString(),
                "sort_by" to "popularity.desc",
                "include_adult" to "false",
            )
            if (italianOnly) params["with_original_language"] = "it"
            if (cartoonOnly) params["with_genres"] = "16"
            filters.year?.let { params["primary_release_year"] = it.toString() }
            filters.dateFrom?.takeIf { it.isNotBlank() }?.let { params["primary_release_date.gte"] = it }
            filters.dateTo?.takeIf { it.isNotBlank() }?.let { params["primary_release_date.lte"] = it }
            TMDb3.Discover.movie(params).results
        } else null

        val tvDeferred = if (includeTv) async {
            val params = mutableMapOf(
                "language" to language,
                "page" to page.toString(),
                "sort_by" to "popularity.desc",
                "include_adult" to "false",
            )
            if (italianOnly) params["with_original_language"] = "it"
            if (cartoonOnly) params["with_genres"] = "16"
            filters.year?.let { params["first_air_date_year"] = it.toString() }
            filters.dateFrom?.takeIf { it.isNotBlank() }?.let { params["first_air_date.gte"] = it }
            filters.dateTo?.takeIf { it.isNotBlank() }?.let { params["first_air_date.lte"] = it }
            TMDb3.Discover.tv(params).results
        } else null

        val movieItems = movieDeferred?.await().orEmpty()
            .asSequence()
            .filter { !excludeItalian || it.originalLanguage != "it" }
            .filter { query.isBlank() || it.title.contains(query, ignoreCase = true) || it.originalTitle.contains(query, ignoreCase = true) }
            .map { movie ->
                Movie(
                    id = movie.id.toString(),
                    title = movie.title,
                    overview = movie.overview,
                    released = movie.releaseDate,
                    rating = movie.voteAverage.toDouble(),
                    poster = movie.posterPath?.w500,
                    banner = movie.backdropPath?.original,
                ) as AppAdapter.Item
            }
            .toList()

        val tvItems = tvDeferred?.await().orEmpty()
            .asSequence()
            .filter { !excludeItalian || it.originalLanguage != "it" }
            .filter { query.isBlank() || it.name.contains(query, ignoreCase = true) || it.originalName.contains(query, ignoreCase = true) }
            .map { tv ->
                TvShow(
                    id = tv.id.toString(),
                    title = tv.name,
                    overview = tv.overview,
                    released = tv.firstAirDate,
                    rating = tv.voteAverage.toDouble(),
                    poster = tv.posterPath?.w500,
                    banner = tv.backdropPath?.original,
                ) as AppAdapter.Item
            }
            .toList()

        (movieItems + tvItems).sortedByDescending {
            when (it) {
                is Movie -> it.rating
                is TvShow -> it.rating
                else -> 0.0
            }
        }
    }

    fun searchGlobal(query: String, currentLanguage: String) = viewModelScope.launch(Dispatchers.IO) {
        _state.emit(State.GlobalSearching)

        val isCurrentProviderIptv = UserPreferences.currentProvider is IptvProvider
        val targetProviders = Provider.providers.keys
            .filter { it.language == currentLanguage && (it is IptvProvider) == isCurrentProviderIptv }
            .toList()

        if (targetProviders.isEmpty()) {
            _state.emit(State.SuccessGlobalSearching(emptyList()))
            return@launch
        }

        val initialResults = targetProviders.map { provider ->
            ProviderResult(provider, ProviderResult.State.Loading)
        }
        _state.emit(State.SuccessGlobalSearching(initialResults))

        val mutableResults = initialResults.toMutableList()
        val stateComparator = compareBy<ProviderResult> { providerResult ->
            when (val state = providerResult.state) {
                is ProviderResult.State.Success -> if (state.results.isNotEmpty()) 1 else 3
                is ProviderResult.State.Loading -> 2
                is ProviderResult.State.Error -> 4
            }
        }

        targetProviders.forEachIndexed { index, provider ->
            launch {
                try {
                    val results = ParentalControlUtils.filterItems(provider.search(query).onEach { item ->
                        when (item) {
                            is Movie -> item.providerName = provider.name
                            is TvShow -> item.providerName = provider.name
                        }
                    })
                    mutableResults[index] = ProviderResult(provider, ProviderResult.State.Success(results))
                } catch (e: Exception) {
                    Log.e("SearchViewModel", "searchGlobal for ${provider.name}: ", e)
                    mutableResults[index] = ProviderResult(provider, ProviderResult.State.Error(e))
                }

                _state.emit(State.SuccessGlobalSearching(mutableResults.sortedWith(stateComparator)))
            }
        }
    }
}

private fun AppAdapter.Item.searchIdentityKey(): String = when (this) {
    is Movie -> "movie:$id"
    is TvShow -> "tvshow:$id"
    else -> "${this::class.java.name}:${hashCode()}"
}
