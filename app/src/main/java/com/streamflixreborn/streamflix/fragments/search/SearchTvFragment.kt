package com.streamflixreborn.streamflix.fragments.search

import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.animation.AlphaAnimation
import android.view.animation.Animation
import android.view.inputmethod.EditorInfo
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.flowWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.leanback.widget.OnChildViewHolderSelectedListener
import androidx.navigation.fragment.findNavController
import androidx.recyclerview.widget.RecyclerView
import com.streamflixreborn.streamflix.R
import com.streamflixreborn.streamflix.adapters.AppAdapter
import com.streamflixreborn.streamflix.database.AppDatabase
import com.streamflixreborn.streamflix.databinding.FragmentSearchTvBinding
import com.streamflixreborn.streamflix.models.Category
import com.streamflixreborn.streamflix.models.Genre
import com.streamflixreborn.streamflix.models.Movie
import com.streamflixreborn.streamflix.models.TvShow
import com.streamflixreborn.streamflix.providers.IptvProvider
import com.streamflixreborn.streamflix.providers.Provider
import com.streamflixreborn.streamflix.providers.TmdbProvider
import com.streamflixreborn.streamflix.utils.CacheUtils
import com.streamflixreborn.streamflix.utils.LoggingUtils
import com.streamflixreborn.streamflix.utils.UserPreferences
import com.streamflixreborn.streamflix.utils.VoiceRecognitionHelper
import com.streamflixreborn.streamflix.utils.hideKeyboard
import com.streamflixreborn.streamflix.utils.viewModelsFactory
import kotlinx.coroutines.launch

class SearchTvFragment : Fragment() {

    private var hasAutoCleared409: Boolean = false
    private var _binding: FragmentSearchTvBinding? = null
    private val binding get() = _binding!!

    private val database by lazy { AppDatabase.getInstance(requireContext()) }
    private val viewModel by viewModelsFactory { SearchViewModel(database) }
    private var isGlobalSearchChecked: Boolean = false
    private var currentGridColumns: Int = 1

    private val appAdapter by lazy {
        AppAdapter().apply {
            onMovieClickListener = { movie ->
                switchProviderIfNeeded(movie.providerName)
                findNavController().navigate(
                    SearchTvFragmentDirections.actionSearchToMovie(id = movie.id)
                )
            }
            onTvShowClickListener = { tvShow ->
                switchProviderIfNeeded(tvShow.providerName)
                findNavController().navigate(
                    SearchTvFragmentDirections.actionSearchToTvShow(
                        id = tvShow.id,
                        poster = tvShow.poster,
                        banner = tvShow.banner,
                    )
                )
            }
        }
    }

    private lateinit var voiceHelper: VoiceRecognitionHelper

    private fun switchProviderIfNeeded(providerName: String?) {
        val targetName = providerName?.takeIf { it.isNotBlank() } ?: return
        if (targetName == UserPreferences.currentProvider?.name) return

        val targetProvider = Provider.providers.keys.find { it.name == targetName } ?: return
        UserPreferences.currentProvider = targetProvider
        Toast.makeText(
            requireContext(),
            getString(R.string.switching_to_provider, targetName),
            Toast.LENGTH_SHORT,
        ).show()
    }

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View {
        _binding = FragmentSearchTvBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        initializeSearch()
        initializeAdvancedFilters()

        viewLifecycleOwner.lifecycleScope.launch {
            viewModel.state.flowWithLifecycle(lifecycle, Lifecycle.State.STARTED).collect { state ->
                when (state) {
                    is State.Searching, is State.GlobalSearching -> {
                        binding.isLoading.apply {
                            root.visibility = View.VISIBLE
                            pbIsLoading.visibility = View.VISIBLE
                            gIsLoadingRetry.visibility = View.GONE
                        }
                        appAdapter.isLoading = false
                        appAdapter.setOnLoadMoreListener(null)
                    }
                    is State.SearchingMore -> appAdapter.isLoading = true
                    is State.SuccessSearching -> {
                        displaySearch(state.results, state.hasMore)
                        appAdapter.isLoading = false
                        binding.vgvSearch.visibility = View.VISIBLE
                        binding.isLoading.root.visibility = View.GONE
                    }
                    is State.SuccessGlobalSearching -> {
                        displayGlobalSearch(state.providerResults)
                        appAdapter.isLoading = false
                        binding.vgvSearch.visibility = View.VISIBLE
                        binding.isLoading.root.visibility = View.GONE
                    }
                    is State.FailedSearching -> {
                        val code = (state.error as? retrofit2.HttpException)?.code()
                        if (code == 409 && !hasAutoCleared409) {
                            hasAutoCleared409 = true
                            CacheUtils.clearAppCache(requireContext())
                            Toast.makeText(requireContext(), getString(R.string.clear_cache_done_409), Toast.LENGTH_SHORT).show()
                            if (appAdapter.isLoading) appAdapter.isLoading = false
                            retryCurrentSearch()
                            return@collect
                        }
                        Toast.makeText(requireContext(), state.error.message ?: "", Toast.LENGTH_SHORT).show()
                        if (appAdapter.isLoading) {
                            appAdapter.isLoading = false
                        } else {
                            binding.isLoading.apply {
                                pbIsLoading.visibility = View.GONE
                                gIsLoadingRetry.visibility = View.VISIBLE
                                btnIsLoadingRetry.setOnClickListener { retryCurrentSearch() }
                                btnIsLoadingClearCache.setOnClickListener {
                                    CacheUtils.clearAppCache(requireContext())
                                    Toast.makeText(requireContext(), getString(R.string.clear_cache_done), Toast.LENGTH_SHORT).show()
                                    retryCurrentSearch()
                                }
                                btnIsLoadingErrorDetails.setOnClickListener {
                                    LoggingUtils.showErrorDialog(requireContext(), state.error)
                                }
                                binding.vgvSearch.visibility = View.INVISIBLE
                                binding.etSearch.nextFocusDownId = binding.isLoading.btnIsLoadingRetry.id
                                binding.isLoading.btnIsLoadingRetry.nextFocusUpId = binding.etSearch.id
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        voiceHelper.stopRecognition()
        _binding = null
    }

    private fun initializeAdvancedFilters() {
        AdvancedSearchUi.setup(
            requireContext(),
            binding.spContentType,
            binding.spItalian,
            binding.spYear,
        )

        binding.btnApplyFilters.setOnClickListener { submitSearch() }
        binding.btnResetFilters.setOnClickListener {
            AdvancedSearchUi.reset(
                binding.spContentType,
                binding.spItalian,
                binding.spYear,
                binding.etDateFrom,
                binding.etDateTo,
            )
            viewModel.search(binding.etSearch.text?.toString().orEmpty())
        }

        listOf(
            binding.spContentType,
            binding.spItalian,
            binding.spYear,
            binding.etDateFrom,
            binding.etDateTo,
            binding.btnResetFilters,
            binding.btnApplyFilters,
        ).forEach { view ->
            view.setOnKeyListener { _, keyCode, event ->
                if (event.action == KeyEvent.ACTION_DOWN && keyCode == KeyEvent.KEYCODE_BACK) {
                    focusSearchContent()
                } else {
                    false
                }
            }
        }
    }

    private fun submitSearch(): Boolean {
        val query = binding.etSearch.text?.toString().orEmpty()
        hideKeyboard()

        val filters = try {
            AdvancedSearchUi.read(
                binding.spContentType,
                binding.spItalian,
                binding.spYear,
                binding.etDateFrom,
                binding.etDateTo,
            )
        } catch (e: IllegalArgumentException) {
            Toast.makeText(requireContext(), e.message ?: "Filtro non valido", Toast.LENGTH_SHORT).show()
            return true
        }

        if (filters.isActive) {
            isGlobalSearchChecked = false
            binding.ivGlobalSearchSwitch.setImageResource(R.drawable.ic_switch_off)
            if (UserPreferences.currentProvider !is TmdbProvider) {
                val language = UserPreferences.currentProvider?.language?.takeIf { it.isNotBlank() } ?: "it"
                UserPreferences.currentProvider = TmdbProvider(language)
            }
            viewModel.searchAdvanced(query, filters)
            return true
        }

        if (isGlobalSearchChecked) {
            if (query.isBlank()) {
                Toast.makeText(requireContext(), getString(R.string.search_empty_query), Toast.LENGTH_SHORT).show()
                return true
            }
            val currentLanguage = UserPreferences.currentProvider?.language ?: "it"
            viewModel.searchGlobal(query, currentLanguage)
        } else {
            viewModel.search(query)
        }
        return true
    }

    private fun retryCurrentSearch() {
        if (viewModel.advancedFilters.isActive) {
            viewModel.searchAdvanced(viewModel.query, viewModel.advancedFilters)
        } else {
            viewModel.search(viewModel.query)
        }
    }

    private fun initializeSearch() {
        val isIptv = UserPreferences.currentProvider is IptvProvider
        val hintStringRes = if (isIptv) R.string.search_input_hint_iptv else R.string.search_input_hint
        binding.etSearch.hint = getString(hintStringRes)

        binding.llGlobalSearch.nextFocusUpId = binding.etSearch.id
        binding.vgvSearch.nextFocusUpId = binding.btnApplyFilters.id

        binding.llGlobalSearch.setOnClickListener {
            isGlobalSearchChecked = !isGlobalSearchChecked
            binding.ivGlobalSearchSwitch.setImageResource(
                if (isGlobalSearchChecked) R.drawable.ic_switch_on else R.drawable.ic_switch_off
            )
        }

        binding.etSearch.apply {
            setOnEditorActionListener { _, actionId, event ->
                val isSubmitAction = actionId == EditorInfo.IME_ACTION_SEARCH ||
                    actionId == EditorInfo.IME_ACTION_DONE ||
                    actionId == EditorInfo.IME_NULL
                val isSubmitKey = event?.action == KeyEvent.ACTION_DOWN &&
                    (event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER)

                if (isSubmitAction || isSubmitKey) return@setOnEditorActionListener submitSearch()
                false
            }

            setOnKeyListener { _, keyCode, event ->
                if (event.action != KeyEvent.ACTION_DOWN) return@setOnKeyListener false
                if (keyCode == KeyEvent.KEYCODE_BACK) return@setOnKeyListener focusSearchContent()
                if (keyCode == KeyEvent.KEYCODE_ENTER ||
                    keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER ||
                    keyCode == KeyEvent.KEYCODE_SEARCH
                ) return@setOnKeyListener submitSearch()
                false
            }

            addTextChangedListener(object : TextWatcher {
                override fun afterTextChanged(s: Editable?) {
                    if (s.isNullOrBlank()) binding.etSearch.hint = getString(R.string.search_input_hint)
                }
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            })
        }

        val blink = AlphaAnimation(1f, 0.3f).apply {
            duration = 500
            repeatCount = Animation.INFINITE
            repeatMode = Animation.REVERSE
        }

        voiceHelper = VoiceRecognitionHelper(
            fragment = this,
            onResult = { query ->
                binding.btnSearchVoice.clearAnimation()
                binding.etSearch.setText(query)
                submitSearch()
            },
            onError = { msg ->
                Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
                binding.btnSearchVoice.clearAnimation()
                binding.etSearch.hint = getString(R.string.search_input_hint)
            },
            onListeningStateChanged = {
                binding.btnSearchVoice.startAnimation(blink)
                binding.etSearch.hint = getString(R.string.voice_prompt)
            }
        )

        binding.btnSearchVoice.apply {
            requestFocus()
            visibility = if (voiceHelper.isAvailable()) View.VISIBLE else View.GONE
            setOnClickListener { if (!voiceHelper.isListening) voiceHelper.startWithPermissionCheck() }
        }

        listOf(binding.btnSearchClear, binding.btnSearchVoice, binding.llGlobalSearch).forEach { view ->
            view.setOnKeyListener { _, keyCode, event ->
                if (event.action == KeyEvent.ACTION_DOWN && keyCode == KeyEvent.KEYCODE_BACK) {
                    focusSearchContent()
                } else false
            }
        }

        binding.btnSearchClear.setOnClickListener {
            binding.etSearch.setText("")
            binding.etSearch.hint = getString(R.string.search_input_hint)
            submitSearch()
        }

        binding.vgvSearch.apply {
            adapter = appAdapter.apply {
                stateRestorationPolicy = RecyclerView.Adapter.StateRestorationPolicy.PREVENT_WHEN_EMPTY
            }
            setItemSpacing(resources.getDimension(R.dimen.search_spacing).toInt())
            addOnChildViewHolderSelectedListener(object : OnChildViewHolderSelectedListener() {
                override fun onChildViewHolderSelected(
                    parent: RecyclerView,
                    child: RecyclerView.ViewHolder?,
                    position: Int,
                    subposition: Int,
                ) {
                    child?.itemView?.nextFocusUpId =
                        if (position in 0 until currentGridColumns) binding.btnApplyFilters.id else View.NO_ID
                }
            })
        }

        binding.root.requestFocus()
    }

    private fun focusSearchContent(): Boolean {
        val hasResults = appAdapter.itemCount > 0 && binding.vgvSearch.visibility == View.VISIBLE
        return when {
            hasResults -> binding.vgvSearch.requestFocus()
            binding.btnApplyFilters.visibility == View.VISIBLE -> binding.btnApplyFilters.requestFocus()
            binding.llGlobalSearch.visibility == View.VISIBLE -> binding.llGlobalSearch.requestFocus()
            else -> false
        }
    }

    private fun displaySearch(list: List<AppAdapter.Item>, hasMore: Boolean) {
        currentGridColumns = if (viewModel.query.isEmpty() && !viewModel.advancedFilters.isActive) 5 else 6
        binding.vgvSearch.setNumColumns(currentGridColumns)

        appAdapter.submitList(list.onEach {
            when (it) {
                is Genre -> it.itemType = AppAdapter.Type.GENRE_GRID_TV_ITEM
                is Movie -> it.itemType = AppAdapter.Type.MOVIE_GRID_TV_ITEM
                is TvShow -> it.itemType = AppAdapter.Type.TV_SHOW_GRID_TV_ITEM
            }
        })

        if (hasMore && (viewModel.query.isNotEmpty() || viewModel.advancedFilters.isActive)) {
            appAdapter.setOnLoadMoreListener { viewModel.loadMore() }
        } else {
            appAdapter.setOnLoadMoreListener(null)
        }
    }

    private fun displayGlobalSearch(providerResults: List<ProviderResult>) {
        val categories = providerResults.map { providerResult ->
            val headerTitle = when (val state = providerResult.state) {
                is ProviderResult.State.Loading -> "${providerResult.provider.name} - ${getString(R.string.searching)}"
                is ProviderResult.State.Error -> "${providerResult.provider.name} - ${getString(R.string.search_error)}"
                is ProviderResult.State.Success -> {
                    val count = state.results.size
                    val resultText = if (count == 1) getString(R.string.result) else getString(R.string.results)
                    "${providerResult.provider.name} - $count $resultText"
                }
            }

            val items = (providerResult.state as? ProviderResult.State.Success)?.results?.onEach {
                when (it) {
                    is Movie -> it.itemType = AppAdapter.Type.MOVIE_TV_ITEM
                    is TvShow -> it.itemType = AppAdapter.Type.TV_SHOW_TV_ITEM
                }
            } ?: emptyList()

            Category(name = headerTitle, list = items).apply {
                itemType = AppAdapter.Type.CATEGORY_TV_ITEM
            }
        }

        currentGridColumns = 1
        binding.vgvSearch.setNumColumns(currentGridColumns)
        appAdapter.submitList(categories)
        appAdapter.setOnLoadMoreListener(null)
    }
}
