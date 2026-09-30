package com.streamflixreborn.streamflix.fragments.search

import android.content.Context
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.Spinner
import com.streamflixreborn.streamflix.providers.AdvancedSearchFilters
import java.text.SimpleDateFormat
import java.util.Locale

internal object AdvancedSearchUi {
    private val years = (2026 downTo 1900).toList()

    fun setup(
        context: Context,
        contentType: Spinner,
        italian: Spinner,
        year: Spinner,
    ) {
        contentType.adapter = ArrayAdapter(
            context,
            android.R.layout.simple_spinner_dropdown_item,
            listOf("Tutti", "Film", "Serie", "Cartoni"),
        )
        italian.adapter = ArrayAdapter(
            context,
            android.R.layout.simple_spinner_dropdown_item,
            listOf("Italiani: tutti", "Italiani: sì", "Italiani: no"),
        )
        year.adapter = ArrayAdapter(
            context,
            android.R.layout.simple_spinner_dropdown_item,
            listOf("Anno: tutti") + years.map { it.toString() },
        )
    }

    fun read(
        contentType: Spinner,
        italian: Spinner,
        year: Spinner,
        dateFrom: EditText,
        dateTo: EditText,
    ): AdvancedSearchFilters {
        val from = dateFrom.text?.toString()?.trim().orEmpty()
        val to = dateTo.text?.toString()?.trim().orEmpty()

        validateDate(from, "Data iniziale")
        validateDate(to, "Data finale")
        if (from.isNotEmpty() && to.isNotEmpty() && from > to) {
            throw IllegalArgumentException("La data iniziale non può essere successiva alla data finale")
        }

        val selectedYear = year.selectedItemPosition
            .takeIf { it > 0 }
            ?.let { years[it - 1] }

        return AdvancedSearchFilters(
            type = when (contentType.selectedItemPosition) {
                1 -> AdvancedSearchFilters.ContentType.MOVIE
                2 -> AdvancedSearchFilters.ContentType.TV
                3 -> AdvancedSearchFilters.ContentType.CARTOON
                else -> AdvancedSearchFilters.ContentType.ALL
            },
            italian = when (italian.selectedItemPosition) {
                1 -> AdvancedSearchFilters.ItalianFilter.YES
                2 -> AdvancedSearchFilters.ItalianFilter.NO
                else -> AdvancedSearchFilters.ItalianFilter.ALL
            },
            year = if (from.isNotEmpty() || to.isNotEmpty()) null else selectedYear,
            dateFrom = from.ifBlank { null },
            dateTo = to.ifBlank { null },
        )
    }

    fun reset(
        contentType: Spinner,
        italian: Spinner,
        year: Spinner,
        dateFrom: EditText,
        dateTo: EditText,
    ) {
        contentType.setSelection(0)
        italian.setSelection(0)
        year.setSelection(0)
        dateFrom.setText("")
        dateTo.setText("")
    }

    private fun validateDate(value: String, label: String) {
        if (value.isBlank()) return
        if (!Regex("\\d{4}-\\d{2}-\\d{2}").matches(value)) {
            throw IllegalArgumentException("$label: usa il formato AAAA-MM-GG")
        }
        val parser = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).apply { isLenient = false }
        runCatching { parser.parse(value) }
            .getOrElse { throw IllegalArgumentException("$label non valida") }
    }
}
