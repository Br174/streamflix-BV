package com.streamflixreborn.streamflix.providers

import com.streamflixreborn.streamflix.adapters.AppAdapter

data class AdvancedSearchFilters(
    val type: ContentType = ContentType.ALL,
    val italian: ItalianFilter = ItalianFilter.ALL,
    val year: Int? = null,
    val dateFrom: String? = null,
    val dateTo: String? = null,
) {
    enum class ContentType { ALL, MOVIE, TV, CARTOON }
    enum class ItalianFilter { ALL, YES, NO }

    val isActive: Boolean
        get() = type != ContentType.ALL ||
            italian != ItalianFilter.ALL ||
            year != null ||
            !dateFrom.isNullOrBlank() ||
            !dateTo.isNullOrBlank()
}

interface AdvancedSearchProvider {
    suspend fun searchAdvanced(
        query: String,
        filters: AdvancedSearchFilters,
        page: Int = 1,
    ): List<AppAdapter.Item>
}
