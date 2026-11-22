const shelvesEl = document.getElementById("shelves");
const statusEl = document.getElementById("statusText");
const articleResultsSection = document.getElementById("articleResults");
const articleResultsEl = document.getElementById("articleCarouselContent");
const lastActionButton = document.getElementById("lastActionButton");
const undoButton = document.getElementById("undoButton");
const carsPerRowInput = document.getElementById("carsPerRow");
const premiumToggleButton = document.getElementById("premiumToggle");
const searchWikiButton = document.getElementById("searchWikiButton");
const shelfImageToggleButton = document.getElementById("shelfImageToggle");
const savedCarsPerRow = Number(localStorage.getItem("tomicaCarsPerRowV1"));
const savedShelfImageMode = localStorage.getItem("tomicaShelfImageModeV1");
let shelfImageMode = savedShelfImageMode === "car" ? "car" : "box";
let carsPerRow =
  Number.isInteger(savedCarsPerRow) &&
  savedCarsPerRow >= 1 &&
  savedCarsPerRow <= 20
    ? savedCarsPerRow
    : 10;
let draggedItem = null;
let draggedArticle = null;
let draggedShelf = null;
let selectedArticle = null;
let activeWikiSearch = null;
let undoLayout = null;
let redoLayout = null;
let lastActionDescription = "";
let historyMode = "undo";
let lastObservedState = null;
let layoutSaveTimeout;
const CLASSIC_TOMICA_CATEGORY = "Category:Classic_Tomica";
const TOMICA_PREMIUM_CATEGORY = "Category:Tomica_Premium";
const WIKI_CATEGORY_CACHE_VERSION = 1;
const WIKI_CATEGORY_CACHE_TTL_MS = 60 * 60 * 1000;
const WIKI_THUMBNAIL_CACHE_KEY = "tomicaWikiThumbnailCacheV1";
const WIKI_THUMBNAIL_CACHE_MAX_ENTRIES = 500;
const WIKI_THUMBNAIL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SHELF_IMAGE_DB_NAME = "tomicaShelfImageBlobs";
const SHELF_IMAGE_DB_VERSION = 1;
const SHELF_IMAGE_STORE_NAME = "images";
let shelfImageDbPromise = null;
const shelfImageBlobPromises = new Map();
const shelfImageObjectUrls = new Map();
const shelfImageObjectUrlPromises = new Map();
carsPerRowInput.value = carsPerRow;

function getSelectedBoxType() {
  return premiumToggleButton.getAttribute("aria-pressed") === "true"
    ? "premium"
    : "standard";
}

function togglePremium() {
  const selected = premiumToggleButton.getAttribute("aria-pressed") !== "true";
  premiumToggleButton.setAttribute("aria-pressed", String(selected));
  searchWikiButton.classList.toggle("premium-selected", selected);
  clearArticleSelection();
}

function fandomJsonp(params) {
  return new Promise((resolve, reject) => {
    const cbName =
      "fandom_cb_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
    const url = new URL("https://tomica.fandom.com/api.php");
    Object.entries({
      ...params,
      format: "json",
      callback: cbName,
    }).forEach(([k, v]) => url.searchParams.set(k, v));

    const script = document.createElement("script");
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Wiki request timed out"));
    }, 8000);

    function cleanup() {
      clearTimeout(timer);
      delete window[cbName];
      script.remove();
    }

    window[cbName] = (data) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("Failed to load Wiki script"));
    };

    script.src = url.toString();
    document.body.appendChild(script);
  });
}

function normalizeQuery(rawInput, boxType = "standard") {
  const trimmed = rawInput.trim();
  if (trimmed.includes("tomica.fandom.com/wiki/")) {
    const afterWiki = trimmed.split("/wiki/").at(1) || "";
    const slug = afterWiki.split("#").at(0).split("?").at(0);
    return {
      pageTitle: decodeURIComponent(slug).replace(/_/g, " "),
      isDirectTitle: true,
    };
  }

  // Separate car numbers from model names without splitting model codes like "F40".
  let cleaned = trimmed
    .replace(/(\d+)([A-Za-z])/g, "$1 $2")
    .replace(/\bNo\.?\s*(\d+)/i, "No. $1")
    .replace(/\s+/g, " ")
    .trim();

  if (boxType === "premium" && !/premium/i.test(cleaned)) {
    cleaned = `Premium ${cleaned}`;
  }

  return { pageTitle: cleaned, isDirectTitle: false };
}

function clearArticleSelection() {
  selectedArticle = null;
  activeWikiSearch = null;
  renderArticleResults([], { state: "default" });
}

function closeArticleResultsSection() {
  articleResultsSection.hidden = true;
}

function showArticleResults() {
  articleResultsSection.hidden = false;
}

function renderArticleResults(
  articles,
  {
    append = false,
    hasMore = false,
    resultCount = articles.length,
    state = "results",
  } = {},
) {
  let resultStrip = articleResultsEl.querySelector(".article-result-strip");
  let list = resultStrip?.querySelector(".article-list");

  if (!append || !resultStrip || !list) {
    articleResultsEl.replaceChildren();
    resultStrip = document.createElement("div");
    resultStrip.className = "article-result-strip";
    list = document.createElement("div");
    list.className = "article-list";
    list.setAttribute("aria-label", "Matching Tomica Wiki articles");
    list.tabIndex = 0;

    const previousButton = document.createElement("button");
    previousButton.type = "button";
    previousButton.className = "secondary carousel-arrow";
    previousButton.setAttribute("aria-label", "Scroll articles left");
    previousButton.textContent = "‹";
    previousButton.addEventListener("click", () => {
      list.scrollBy({ left: -list.clientWidth * 0.8, behavior: "smooth" });
    });

    const nextButton = document.createElement("button");
    nextButton.type = "button";
    nextButton.className = "secondary carousel-arrow";
    nextButton.setAttribute("aria-label", "Scroll articles right");
    nextButton.textContent = "›";
    nextButton.addEventListener("click", () => {
      list.scrollBy({ left: list.clientWidth * 0.8, behavior: "smooth" });
    });

    resultStrip.append(previousButton, list, nextButton);
    articleResultsEl.appendChild(resultStrip);
  }
  const previousScrollLeft = append ? list.scrollLeft : 0;
  const previousScrollSnapType = append ? list.style.scrollSnapType : "";
  if (append) list.style.scrollSnapType = "none";

  articles.forEach((article) => {
    const option = document.createElement("div");
    option.className = "article-option";
    option.dataset.articleTitle = article.title;
    option.draggable = true;

    const articleLink = document.createElement("a");
    articleLink.className = "article-title";
    articleLink.href = wikiArticleUrl(article.title);
    articleLink.target = "_blank";
    articleLink.rel = "noopener noreferrer";
    articleLink.title = article.title;
    articleLink.draggable = false;
    const titleText = document.createElement("span");
    titleText.className = "article-title-text";
    titleText.textContent = article.title;
    articleLink.appendChild(titleText);

    const thumbnailContainer = document.createElement("div");
    thumbnailContainer.className = "article-thumbnail-container";

    if (article.thumbnail) {
      const thumbnail = document.createElement("img");
      thumbnail.className = "article-thumbnail";
      thumbnail.src = article.thumbnail;
      thumbnail.alt = `Thumbnail for ${article.title}`;
      thumbnail.loading = "lazy";
      thumbnail.referrerPolicy = "no-referrer";
      thumbnail.addEventListener(
        "error",
        () => {
          const placeholder = document.createElement("span");
          placeholder.className = "article-thumbnail-placeholder";
          placeholder.textContent = "Thumbnail unavailable";
          thumbnail.replaceWith(placeholder);
        },
        { once: true },
      );
      thumbnail.draggable = false;
      thumbnailContainer.appendChild(thumbnail);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "article-thumbnail-placeholder";
      placeholder.textContent = "No thumbnail available";
      thumbnailContainer.appendChild(placeholder);
    }

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "article-add-button";
    addButton.textContent = "+";
    addButton.title = `Add ${article.title} to shelf`;
    addButton.setAttribute("aria-label", `Add ${article.title} to shelf`);
    addButton.draggable = false;
    addButton.addEventListener("click", () => addBox(article, addButton));
    thumbnailContainer.appendChild(addButton);

    option.addEventListener("click", (event) => {
      if (event.target.closest("a, button")) return;
      selectedArticle = article;
      list.querySelectorAll(".article-option").forEach((item) => {
        item.classList.toggle("selected", item === option);
      });
      statusEl.textContent = `Selected "${article.title}".`;
    });

    option.addEventListener("dragstart", (event) => {
      draggedArticle = article;
      draggedItem = null;
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("text/plain", article.title);
      option.classList.add("dragging");
    });
    option.addEventListener("dragend", () => {
      draggedArticle = null;
      option.classList.remove("dragging");
      shelvesEl
        .querySelectorAll(".shelf-slot.drag-over")
        .forEach((slot) => slot.classList.remove("drag-over"));
    });

    option.append(articleLink, thumbnailContainer);
    list.insertBefore(option, list.querySelector(".load-more-option"));
  });

  let stickyCard = list.querySelector(".load-more-option");
  if (!stickyCard) {
    stickyCard = document.createElement("button");
    stickyCard.type = "button";
    stickyCard.className = "article-option load-more-option";
    stickyCard.addEventListener("click", () => {
      if (stickyCard.dataset.state === "default") {
        document.getElementById("carName").focus();
        searchWikiArticles();
      } else if (
        stickyCard.dataset.state === "results" &&
        stickyCard.dataset.hasMore === "true"
      ) {
        loadMoreWikiArticles(stickyCard);
      }
    });
    list.appendChild(stickyCard);
  }
  updateStickyCard(stickyCard, { state, resultCount, hasMore });
  requestAnimationFrame(() => {
    if (append) {
      list.scrollLeft = previousScrollLeft;
      list.style.scrollSnapType = previousScrollSnapType;
    }
    refreshArticleTitleScroll();
  });
}

function updateStickyCard(
  card,
  { state, resultCount = 0, hasMore = false, batchesChecked = 0 },
) {
  card.dataset.state = state;
  card.dataset.hasMore = String(hasMore);
  card.replaceChildren();

  if (state === "default") {
    card.textContent = "Enter a car number, model name, or Wiki URL";
    card.disabled = false;
    card.setAttribute(
      "aria-label",
      "Enter a car number, model name, or Wiki URL, then search",
    );
    return;
  }

  if (state === "searching") {
    card.textContent = "Loading...";
    card.disabled = true;
    card.setAttribute("aria-label", "Searching Wiki articles");
    return;
  }

  if (state === "no-results") {
    card.textContent = "No results, try again with different search terms";
    card.disabled = true;
    card.setAttribute("aria-label", card.textContent);
    return;
  }

  const count = document.createElement("span");
  count.className = "load-more-result-count";
  count.textContent = `${resultCount} result(s)`;
  card.appendChild(count);

  if (state === "loading-more") {
    const loading = document.createElement("span");
    loading.className = "load-more-label";
    const batchLabel = batchesChecked === 1 ? "batch" : "batches";
    loading.textContent = `Loading for more matches (${batchesChecked} ${batchLabel} checked)`;
    card.appendChild(loading);
    card.disabled = true;
    card.setAttribute(
      "aria-label",
      `${resultCount} result(s). ${loading.textContent}.`,
    );
    return;
  }

  if (hasMore) {
    const label = document.createElement("span");
    label.className = "load-more-label";
    label.textContent = "Load more";
    card.appendChild(label);
  }
  card.disabled = !hasMore;
  card.setAttribute(
    "aria-label",
    hasMore
      ? `${resultCount} result(s). Load more Wiki results.`
      : `${resultCount} result(s). No more results.`,
  );
}

function updateArticleTitleScroll(titleViewport) {
  const titleText = titleViewport.querySelector(".article-title-text");
  const overflow = titleText.scrollWidth - titleViewport.clientWidth;
  titleViewport.classList.toggle("scrolling", overflow > 1);
  if (overflow > 1) {
    titleText.style.setProperty("--article-title-overflow", `-${overflow}px`);
  } else {
    titleText.style.removeProperty("--article-title-overflow");
  }
}

function refreshArticleTitleScroll() {
  if (articleResultsSection.hidden) return;
  articleResultsEl
    .querySelectorAll(".article-title")
    .forEach(updateArticleTitleScroll);
}

window.addEventListener("resize", () => {
  requestAnimationFrame(refreshArticleTitleScroll);
});

async function fetchWikiSearchPage(search) {
  const response = await fandomJsonp({
    action: "query",
    list: "search",
    srsearch: search.pageTitle,
    srnamespace: 0,
    srlimit: search.limit || 10,
    srinfo: "totalhits",
    ...(search.continuation || {}),
  });
  const totalHits = Number(response?.query?.searchinfo?.totalhits);
  return {
    hits: response?.query?.search || [],
    continuation: response?.continue || null,
    totalHits: Number.isFinite(totalHits) ? totalHits : null,
  };
}

function getWikiCategoryCacheKey(category, requestContinuation) {
  return `tomicaWikiCategoryPageV${WIKI_CATEGORY_CACHE_VERSION}:${encodeURIComponent(
    category,
  )}:${encodeURIComponent(JSON.stringify(requestContinuation || {}))}`;
}

function readCachedWikiCategoryPage(category, requestContinuation) {
  const cacheKey = getWikiCategoryCacheKey(category, requestContinuation);
  let serialized;
  try {
    serialized = localStorage.getItem(cacheKey);
  } catch (err) {
    console.error("[Tomica Wiki] category cache read failed", err);
    return null;
  }
  if (serialized === null) return null;

  let cached;
  try {
    cached = JSON.parse(serialized);
  } catch (err) {
    console.warn("[Tomica Wiki] invalid category cache entry", err);
    try {
      localStorage.removeItem(cacheKey);
    } catch (removeError) {
      console.error("[Tomica Wiki] could not remove invalid category cache", removeError);
    }
    return null;
  }

  const now = Date.now();
  const age = now - cached?.fetchedAt;
  const valid =
    cached?.version === WIKI_CATEGORY_CACHE_VERSION &&
    cached.category === category &&
    JSON.stringify(cached.requestContinuation || {}) ===
      JSON.stringify(requestContinuation || {}) &&
    Array.isArray(cached.hits) &&
    cached.hits.every((hit) => typeof hit?.title === "string") &&
    (cached.continuation === null ||
      (typeof cached.continuation === "object" &&
        !Array.isArray(cached.continuation)));
  const expired =
    !Number.isFinite(age) || age < 0 || age >= WIKI_CATEGORY_CACHE_TTL_MS;
  if (!valid) {
    console.warn("[Tomica Wiki] invalid category cache entry; discarding");
  }
  if (!valid || expired) {
    try {
      localStorage.removeItem(cacheKey);
    } catch (err) {
      console.error("[Tomica Wiki] could not remove invalid or expired category cache", err);
    }
    return null;
  }

  return {
    hits: cached.hits,
    continuation: cached.continuation,
  };
}

function writeCachedWikiCategoryPage(category, requestContinuation, page) {
  const cacheKey = getWikiCategoryCacheKey(category, requestContinuation);
  try {
    localStorage.setItem(
      cacheKey,
      JSON.stringify({
        version: WIKI_CATEGORY_CACHE_VERSION,
        category,
        requestContinuation: requestContinuation || {},
        fetchedAt: Date.now(),
        hits: page.hits,
        continuation: page.continuation,
      }),
    );
  } catch (err) {
    console.error("[Tomica Wiki] category cache write failed", err);
  }
}

async function fetchWikiCategoryPage(searchState) {
  const category = searchState.priorityCategories[searchState.categoryIndex];
  const requestContinuation = searchState.categoryContinuation || {};
  const cachedPage = readCachedWikiCategoryPage(category, requestContinuation);
  if (cachedPage) {
    console.info("[Tomica Wiki] category cache hit", { category });
    return cachedPage;
  }

  const response = await fandomJsonp({
    action: "query",
    list: "categorymembers",
    cmtitle: category,
    cmnamespace: 0,
    cmtype: "page",
    cmlimit: 500,
    ...requestContinuation,
  });
  const page = {
    hits: response?.query?.categorymembers || [],
    continuation: response?.continue || null,
  };
  writeCachedWikiCategoryPage(category, requestContinuation, page);
  return page;
}

function logWikiSearchResults(
  action,
  searchTerm,
  resultsReturned,
  resultsShown,
  resultsDuplicated,
  resultsDiscarded,
  batchNumber = null,
) {
  console.info("[Tomica Wiki]", {
    action,
    batchNumber,
    searchTerm,
    resultsReturned,
    resultsShown,
    resultsDuplicated,
    resultsDiscarded,
  });
}

function getWikiSearchQueries(rawNum, rawName, isUrl, fallbackQuery) {
  if (isUrl) return [fallbackQuery];
  const number = rawNum.replace(/^\s*no\.?(?=\s|\d)\s*/i, "").trim();
  const name = rawName.replace(/^\s*no\.?(?=\s|\d)\s*/i, "").trim();

  const inputs = number
    ? [`${number} ${name}`.trim(), `No. ${number} ${name}`.trim()]
    : [name, `No. ${name}`.trim()];
  return [...new Set(inputs.map((input) => normalizeQuery(input).pageTitle))];
}

function hasMoreWikiResults(searchState) {
  return (
    searchState.phase === "category" ||
    searchState.searchNeedsInitialFetch ||
    searchState.searches.some((search) => search.continuation)
  );
}

function partitionSearchHits(searchState, hits) {
  const uniqueHits = [];
  let resultsDuplicated = 0;
  let resultsDiscarded = 0;

  hits.forEach((hit) => {
    if (typeof hit.title !== "string") {
      resultsDiscarded += 1;
      return;
    }
    const title = hit.title.toLowerCase();
    if (searchState.seenTitles.has(title)) {
      resultsDuplicated += 1;
      return;
    }
    searchState.seenTitles.add(title);
    uniqueHits.push(hit);
  });

  return { uniqueHits, resultsDuplicated, resultsDiscarded };
}

function processWikiCategoryPage(searchState, page, action, batchNumber) {
  const { uniqueHits, resultsDuplicated, resultsDiscarded } =
    partitionSearchHits(searchState, page.hits);
  const matchingHits = uniqueHits.filter((hit) =>
    titleMatchesQuery(hit.title, searchState.matchQuery),
  );
  logWikiSearchResults(
    action,
    searchState.priorityCategories[searchState.categoryIndex],
    page.hits.length,
    matchingHits.length,
    resultsDuplicated,
    resultsDiscarded + uniqueHits.length - matchingHits.length,
    batchNumber,
  );
  return matchingHits;
}

function getThumbnailCacheTitle(title) {
  return title.trim().replace(/_/g, " ").toLowerCase();
}

function removeWikiThumbnailCache() {
  try {
    localStorage.removeItem(WIKI_THUMBNAIL_CACHE_KEY);
  } catch (err) {
    console.error("[Tomica Wiki] could not remove thumbnail cache", err);
  }
}

function writeWikiThumbnailCache(entries) {
  try {
    localStorage.setItem(
      WIKI_THUMBNAIL_CACHE_KEY,
      JSON.stringify({
        version: 1,
        entries: entries.slice(-WIKI_THUMBNAIL_CACHE_MAX_ENTRIES),
      }),
    );
  } catch (err) {
    console.error("[Tomica Wiki] thumbnail cache write failed", err);
  }
}

function readWikiThumbnailCache() {
  let serialized;
  try {
    serialized = localStorage.getItem(WIKI_THUMBNAIL_CACHE_KEY);
  } catch (err) {
    console.error("[Tomica Wiki] thumbnail cache read failed", err);
    return [];
  }
  if (serialized === null) return [];

  let cache;
  try {
    cache = JSON.parse(serialized);
  } catch (err) {
    console.warn("[Tomica Wiki] invalid thumbnail cache; discarding", err);
    removeWikiThumbnailCache();
    return [];
  }
  if (cache?.version !== 1 || !Array.isArray(cache.entries)) {
    console.warn("[Tomica Wiki] invalid thumbnail cache; discarding");
    removeWikiThumbnailCache();
    return [];
  }

  const now = Date.now();
  const freshEntries = cache.entries.filter((entry) => {
    if (
      typeof entry?.title !== "string" ||
      typeof entry.thumbnail !== "string" ||
      !Number.isFinite(entry.fetchedAt)
    ) {
      console.warn("[Tomica Wiki] invalid thumbnail cache entry; discarding");
      return false;
    }
    const age = now - entry.fetchedAt;
    return age >= 0 && age < WIKI_THUMBNAIL_CACHE_TTL_MS;
  });
  const boundedEntries = freshEntries.slice(-WIKI_THUMBNAIL_CACHE_MAX_ENTRIES);
  if (boundedEntries.length !== cache.entries.length) {
    writeWikiThumbnailCache(boundedEntries);
  }
  return boundedEntries;
}

async function fetchArticleThumbnails(hits) {
  if (!hits.length) return { articles: [], warning: "" };

  const cacheEntries = readWikiThumbnailCache();
  const thumbnailsByTitle = new Map(
    cacheEntries.map((entry) => [
      getThumbnailCacheTitle(entry.title),
      entry.thumbnail,
    ]),
  );
  const uncachedHits = hits.filter(
    (article) => !thumbnailsByTitle.has(getThumbnailCacheTitle(article.title)),
  );

  try {
    if (uncachedHits.length) {
      const thumbnailData = await fandomJsonp({
        action: "query",
        titles: uncachedHits.map((article) => article.title).join("|"),
        prop: "pageimages",
        piprop: "thumbnail",
        pithumbsize: 320,
      });
      const fetchedThumbnailsByTitle = new Map(
        Object.values(thumbnailData?.query?.pages || {})
          .filter((page) => typeof page.title === "string")
          .map((page) => [
            getThumbnailCacheTitle(page.title),
            page.thumbnail?.source || "",
          ]),
      );
      const updatedCache = new Map(
        cacheEntries.map((entry) => [
          getThumbnailCacheTitle(entry.title),
          entry,
        ]),
      );
      const fetchedAt = Date.now();
      uncachedHits.forEach((article) => {
        const title = getThumbnailCacheTitle(article.title);
        const thumbnail = fetchedThumbnailsByTitle.get(title) || "";
        thumbnailsByTitle.set(title, thumbnail);
        updatedCache.set(title, {
          title: article.title,
          thumbnail,
          fetchedAt,
        });
      });
      writeWikiThumbnailCache([...updatedCache.values()]);
    }

    return {
      articles: hits.map((article) => ({
        ...article,
        thumbnail:
          thumbnailsByTitle.get(getThumbnailCacheTitle(article.title)) || "",
      })),
      warning: "",
    };
  } catch (err) {
    console.error(err);
    return {
      articles: hits.map((article) => ({
        ...article,
        thumbnail:
          thumbnailsByTitle.get(getThumbnailCacheTitle(article.title)) || "",
      })),
      warning: ` Thumbnail loading failed: ${err.message}.`,
    };
  }
}

function titleMatchesQuery(title, query) {
  const tokenize = (text) =>
    text
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.replace(/[^a-z0-9]/g, ""))
      .filter(Boolean);
  const mergeSeparatedLetterTokens = (terms) => {
    const merged = [];
    terms.forEach((term) => {
      const previous = merged[merged.length - 1];
      if (
        previous &&
        /^[a-z]+$/.test(previous) &&
        /^[a-z]+$/.test(term) &&
        (previous.length === 1 || term.length === 1)
      ) {
        merged[merged.length - 1] += term;
      } else {
        merged.push(term);
      }
    });
    return merged;
  };
  const terms = mergeSeparatedLetterTokens(
    tokenize(query).filter((term) => term !== "no"),
  );
  const rawTitleTerms = tokenize(title);
  const titleTerms = new Set([
    ...rawTitleTerms,
    ...mergeSeparatedLetterTokens(rawTitleTerms),
  ]);
  return terms.length > 0 && terms.every((term) => titleTerms.has(term));
}

async function searchWikiArticles() {
  const rawNum = document.getElementById("carNum").value.trim();
  const rawName = document.getElementById("carName").value.trim();
  const boxType = getSelectedBoxType();
  const isUrl = rawName.includes("tomica.fandom.com/wiki/");
  const searchQuery = isUrl ? rawName : `${rawNum} ${rawName}`.trim();

  clearArticleSelection();
  showArticleResults();
  statusEl.textContent = "";
  renderArticleResults([], { state: "searching" });
  if (!searchQuery) {
    renderArticleResults([], { state: "default" });
    return;
  }

  let searchState;
  try {
    const { pageTitle, isDirectTitle } = normalizeQuery(searchQuery, boxType);
    const matchQuery = isDirectTitle
      ? pageTitle
      : normalizeQuery(searchQuery).pageTitle;
    const searchQueries = isDirectTitle
      ? []
      : getWikiSearchQueries(rawNum, rawName, isUrl, matchQuery);
    const priorityCategories = isDirectTitle
      ? []
      : boxType === "premium"
        ? [TOMICA_PREMIUM_CATEGORY, CLASSIC_TOMICA_CATEGORY]
        : [CLASSIC_TOMICA_CATEGORY, TOMICA_PREMIUM_CATEGORY];
    searchState = {
      pageTitle,
      matchQuery,
      boxType,
      isDirectTitle,
      phase: priorityCategories.length ? "category" : "search",
      priorityCategories,
      categoryIndex: 0,
      searchQueries,
      categoryContinuation: null,
      categoryNeedsInitialFetch: false,
      searchNeedsInitialFetch: false,
      searches: [],
      totalHits: null,
      seenTitles: new Set(),
      articles: [],
      loading: false,
    };
    activeWikiSearch = searchState;

    const matchingHits = [];
    if (isDirectTitle) {
      const { uniqueHits } = partitionSearchHits(searchState, [
        { title: pageTitle },
      ]);
      matchingHits.push(...uniqueHits);
      console.info("[Tomica Wiki] direct title lookup", {
        title: pageTitle,
        searchRequestSent: false,
        resultsShown: uniqueHits.length,
      });
    } else if (priorityCategories.length) {
      let batchesChecked = 0;
      while (true) {
        const page = await fetchWikiCategoryPage(searchState);
        if (activeWikiSearch !== searchState) return;
        searchState.categoryContinuation = page.continuation;
        searchState.categoryNeedsInitialFetch = false;
        batchesChecked += 1;
        matchingHits.push(
          ...processWikiCategoryPage(
            searchState,
            page,
            "category search",
            batchesChecked,
          ),
        );
        if (matchingHits.length) break;
        if (searchState.categoryContinuation) continue;
        if (searchState.categoryIndex + 1 >= priorityCategories.length) break;
        searchState.categoryIndex += 1;
      }
    } else {
      searchState.searches = searchQueries.map((query) => ({
        pageTitle: query,
        continuation: null,
        limit: 10,
      }));
      const pages = await Promise.all(
        searchState.searches.map((search) => fetchWikiSearchPage(search)),
      );
      if (activeWikiSearch !== searchState) return;
      pages.forEach((page, index) => {
        searchState.searches[index].continuation = page.continuation;
        searchState.searches[index].totalHits = page.totalHits;
      });
      searchState.totalHits = pages[0]?.totalHits ?? null;

      pages.forEach((page, index) => {
        const { uniqueHits, resultsDuplicated, resultsDiscarded } =
          partitionSearchHits(searchState, page.hits);
        const matchingPageHits = uniqueHits.filter((hit) =>
          titleMatchesQuery(hit.title, matchQuery),
        );
        matchingHits.push(...matchingPageHits);
        logWikiSearchResults(
          "search",
          searchState.searches[index].pageTitle,
          page.hits.length,
          matchingPageHits.length,
          resultsDuplicated,
          resultsDiscarded + uniqueHits.length - matchingPageHits.length,
          1,
        );
      });
    }
    const thumbnailResult = await fetchArticleThumbnails(matchingHits);
    if (activeWikiSearch !== searchState) return;
    searchState.articles.push(...thumbnailResult.articles);

    if (!searchState.articles.length && !hasMoreWikiResults(searchState)) {
      renderArticleResults([], { state: "no-results" });
      return;
    }

    renderArticleResults(searchState.articles, {
      hasMore: hasMoreWikiResults(searchState),
      resultCount: searchState.articles.length,
    });
    statusEl.textContent = thumbnailResult.warning.trim();
    if (!searchState.articles.length && hasMoreWikiResults(searchState)) {
      const loadMoreButton = articleResultsEl.querySelector(".load-more-option");
      if (loadMoreButton) {
        await loadMoreWikiArticles(loadMoreButton);
      }
    }
  } catch (err) {
    console.error(err);
    if (searchState && activeWikiSearch !== searchState) return;
    statusEl.textContent = `Wiki search error: ${err.message}`;
    renderArticleResults([], { state: "default" });
  }
}

async function loadMoreWikiArticles(button) {
  const searchState = activeWikiSearch;
  if (!searchState || searchState.isDirectTitle || searchState.loading) {
    return;
  }

  searchState.loading = true;
  statusEl.textContent = "";
  let batchesChecked = 0;
  updateStickyCard(button, {
    state: "loading-more",
    resultCount: searchState.articles.length,
    batchesChecked,
  });

  try {
    const matchingHits = [];
    while (true) {
      if (searchState.phase === "category") {
        if (
          searchState.categoryNeedsInitialFetch ||
          searchState.categoryContinuation
        ) {
          const page = await fetchWikiCategoryPage(searchState);
          if (activeWikiSearch !== searchState) return;
          batchesChecked += 1;
          searchState.categoryContinuation = page.continuation;
          searchState.categoryNeedsInitialFetch = false;
          matchingHits.push(
            ...processWikiCategoryPage(
              searchState,
              page,
              "category load more",
              batchesChecked,
            ),
          );
          updateStickyCard(button, {
            state: "loading-more",
            resultCount: searchState.articles.length,
            batchesChecked,
          });
          if (matchingHits.length) break;
          if (searchState.categoryContinuation) continue;
        }

        if (searchState.categoryIndex + 1 < searchState.priorityCategories.length) {
          searchState.categoryIndex += 1;
          searchState.categoryContinuation = null;
          searchState.categoryNeedsInitialFetch = true;
          continue;
        }

        searchState.phase = "search";
        searchState.searches = searchState.searchQueries.map((query) => ({
          pageTitle: query,
          continuation: null,
          limit: 10,
        }));
        searchState.searchNeedsInitialFetch = true;
      }

      const isInitialSearchBatch = searchState.searchNeedsInitialFetch;
      const activeSearches = isInitialSearchBatch
        ? searchState.searches
        : searchState.searches.filter((search) => search.continuation);
      if (!activeSearches.length) break;

      const pages = await Promise.all(
        activeSearches.map(async (search) => ({
          search,
          page: await fetchWikiSearchPage(search),
        })),
      );
      if (activeWikiSearch !== searchState) return;
      if (isInitialSearchBatch) {
        searchState.searchNeedsInitialFetch = false;
      }
      batchesChecked += 1;

      pages.forEach(({ search, page }) => {
        search.continuation = page.continuation;
        searchState.totalHits = page.totalHits ?? searchState.totalHits;

        const { uniqueHits, resultsDuplicated, resultsDiscarded } =
          partitionSearchHits(searchState, page.hits);
        const matchingPageHits = uniqueHits.filter((hit) =>
          titleMatchesQuery(hit.title, searchState.matchQuery),
        );
        matchingHits.push(...matchingPageHits);
        logWikiSearchResults(
          "load more",
          search.pageTitle,
          page.hits.length,
          matchingPageHits.length,
          resultsDuplicated,
          resultsDiscarded + uniqueHits.length - matchingPageHits.length,
          batchesChecked,
        );

        if (matchingPageHits.length) {
          search.limit = 10;
        } else {
          search.limit = page.continuation ? 50 : 10;
        }
      });

      updateStickyCard(button, {
        state: "loading-more",
        resultCount: searchState.articles.length,
        batchesChecked,
      });
      if (matchingHits.length || !hasMoreWikiResults(searchState)) break;
    }

    const thumbnailResult = await fetchArticleThumbnails(matchingHits);
    if (activeWikiSearch !== searchState) return;
    searchState.articles.push(...thumbnailResult.articles);

    if (!searchState.articles.length && !hasMoreWikiResults(searchState)) {
      renderArticleResults([], { state: "no-results" });
      return;
    }

    renderArticleResults(thumbnailResult.articles, {
      append: true,
      hasMore: hasMoreWikiResults(searchState),
      resultCount: searchState.articles.length,
    });
    statusEl.textContent = thumbnailResult.warning.trim();
  } catch (err) {
    console.error(err);
    if (activeWikiSearch !== searchState) return;
    statusEl.textContent = `Could not load more Wiki results: ${err.message}`;
    if (button.isConnected) {
      updateStickyCard(button, {
        state: "results",
        resultCount: searchState.articles.length,
        hasMore: hasMoreWikiResults(searchState),
      });
    }
  } finally {
    searchState.loading = false;
  }
}

async function fetchWikiImages(rawInput, boxType = "standard") {
  if (!rawInput.trim()) {
    return {
      title: "",
      images: [],
      imageTitles: [],
      error: "No article title supplied.",
    };
  }
  statusEl.textContent = "Searching Tomica Wiki...";

  try {
    const { pageTitle, isDirectTitle } = normalizeQuery(rawInput, boxType);
    let resolvedTitle = pageTitle;

    if (!isDirectTitle) {
      const searchData = await fandomJsonp({
        action: "query",
        list: "search",
        srsearch: pageTitle,
        srlimit: 5,
      });
      const hits = searchData?.query?.search || [];
      if (!hits.length) {
        const error = `No wiki article found for "${pageTitle}".`;
        statusEl.textContent = error;
        return { title: pageTitle, images: [], imageTitles: [], error };
      }
      // Prefer exact match for Premium vs Standard if multiple hits return
      const preferredHit =
        boxType === "premium"
          ? hits.find((h) => /premium/i.test(h.title)) || hits.at(0)
          : hits.find((h) => !/premium/i.test(h.title)) || hits.at(0);
      resolvedTitle = preferredHit.title;
    }

    const imgListData = await fandomJsonp({
      action: "query",
      titles: resolvedTitle,
      prop: "images",
      imlimit: 25,
    });

    const firstPage = Object.values(imgListData?.query?.pages || {}).at(0);
    const rawFiles = (firstPage?.images || [])
      .map((img) => img.title)
      .filter((t) => /\.(jpg|jpeg|png|webp)$/i.test(t))
      .filter(
        (t) =>
          !/(logo|icon|placeholder|stub|banner|wordmark|button|arrow|wiki)/i.test(
            t,
          ),
      );

    if (!rawFiles.length) {
      const error = `Article "${resolvedTitle}" has no car/box images.`;
      statusEl.textContent = error;
      return { title: resolvedTitle, images: [], imageTitles: [], error };
    }

    // Sort so files containing "box" appear first, followed by main car images
    rawFiles.sort((a, b) => {
      const aBox = /box/i.test(a) ? 0 : 1;
      const bBox = /box/i.test(b) ? 0 : 1;
      return aBox - bBox;
    });

    const infoData = await fandomJsonp({
      action: "query",
      titles: rawFiles.join("|"),
      prop: "imageinfo",
      iiprop: "url",
      iiurlwidth: 320,
    });

    const infoPages = Object.values(infoData?.query?.pages || {});
    // Preserve sorted order from rawFiles
    const urlMap = new Map();
    infoPages.forEach((p) => {
      const info = (p.imageinfo || []).at(0);
      const src = info?.thumburl || info?.url;
      if (src && p.title) {
        urlMap.set(p.title.toLowerCase(), src);
      }
    });

    const imageOptions = rawFiles
      .map((title) => ({
        title: title.replace(/^File:/i, ""),
        url: urlMap.get(title.toLowerCase()),
      }))
      .filter((image) => image.url);

    const error = imageOptions.length ? "" : "No valid image URLs returned.";
    statusEl.textContent = imageOptions.length
      ? `Loaded ${imageOptions.length} image(s) from "${resolvedTitle}".`
      : error;
    setTimeout(() => {
      if (statusEl.textContent.startsWith("Loaded")) statusEl.textContent = "";
    }, 3000);

    return {
      title: resolvedTitle,
      images: imageOptions.map((image) => image.url),
      imageTitles: imageOptions.map((image) => image.title),
      error,
    };
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Wiki fetch error: ${err.message}`;
    return {
      title: "",
      images: [],
      imageTitles: [],
      error: statusEl.textContent,
    };
  }
}

function getSlotData(slot) {
  const box = slot.querySelector(".box");
  if (!box) return null;
  return {
    num: box.dataset.num,
    name: box.dataset.name,
    type: box.dataset.type,
    images: JSON.parse(box.dataset.images || "[]"),
    imageTitles: JSON.parse(box.dataset.imageTitles || "[]"),
    imgIdx: parseInt(box.dataset.imgIdx || "0", 10),
    boxImgIdx: parseInt(box.dataset.boxImgIdx || "0", 10),
    carImgIdx: parseInt(box.dataset.carImgIdx || "0", 10),
    imageMode: box.dataset.imageMode || "box",
    articleTitle: box.dataset.articleTitle || "",
  };
}

function imageTitleFromUrl(url, index) {
  const fileName = String(url)
    .split(/[?#]/, 1)[0]
    .split("/")
    .filter(Boolean)
    .reverse()
    .find((part) => /\.(jpg|jpeg|png|webp)$/i.test(part));
  return fileName || `Image ${index + 1}`;
}

function defaultCarImageIndex(imageTitles, imageCount, boxImgIdx = 0) {
  const carImageIdx = imageTitles.findIndex(
    (title, index) => index !== boxImgIdx && !/box/i.test(title),
  );
  if (carImageIdx >= 0) return carImageIdx;
  if (imageCount > 1) return boxImgIdx === 0 ? 1 : 0;
  return boxImgIdx;
}

function normalizeShelfSlots(slots, rowWidth = carsPerRow) {
  const normalized = [...slots];
  const slotCount = Math.max(
    rowWidth,
    Math.ceil(normalized.length / rowWidth) * rowWidth,
  );
  while (normalized.length < slotCount) normalized.push(null);
  return normalized;
}

function updateSlotState(slot) {
  slot.classList.toggle("empty", !slot.querySelector(".box"));
}

function createShelfSlot(index) {
  const slot = document.createElement("div");
  slot.className = "shelf-slot";
  slot.dataset.index = index;
  slot.setAttribute("aria-label", `Shelf slot ${index + 1}`);

  slot.addEventListener("dragover", (event) => {
    if (!draggedItem && !draggedArticle) return;
    if (draggedArticle && slot.querySelector(".box")) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = draggedArticle ? "copy" : "move";
    slot.classList.add("drag-over");
  });
  slot.addEventListener("dragleave", (event) => {
    if (!slot.contains(event.relatedTarget)) {
      slot.classList.remove("drag-over");
    }
  });
  slot.addEventListener("drop", (event) => {
    event.preventDefault();
    slot.classList.remove("drag-over");
    if (draggedArticle) {
      if (slot.querySelector(".box")) {
        statusEl.textContent = "Drop the article onto an empty shelf slot.";
        return;
      }
      addBox(draggedArticle, null, slot);
      return;
    }
    if (!draggedItem) return;

    const sourceSlot = draggedItem.parentElement;
    if (sourceSlot === slot) return;
    const targetBox = slot.querySelector(".box");
    if (targetBox) sourceSlot.appendChild(targetBox);
    slot.appendChild(draggedItem);
    updateSlotState(sourceSlot);
    updateSlotState(slot);
  });

  return slot;
}

function renderShelfSlots(shelf, slots) {
  shelf.style.setProperty("--cars-per-row", carsPerRow);
  shelf.replaceChildren();
  normalizeShelfSlots(slots).forEach((item, index) => {
    const slot = createShelfSlot(index);
    if (item) {
      slot.appendChild(
        createBoxElement(
          item.num,
          item.name,
          item.type,
          item.images || [],
          item.imgIdx || 0,
          {
            articleTitle: item.articleTitle,
            imageTitles: item.imageTitles,
            boxImgIdx: item.boxImgIdx,
            carImgIdx: item.carImgIdx,
            imageMode: item.imageMode,
          },
        ),
      );
    }
    updateSlotState(slot);
    shelf.appendChild(slot);
  });
}

function createShelf(id, slots = Array(carsPerRow).fill(null)) {
  const wrapper = document.createElement("div");
  wrapper.className = "shelf-wrapper";

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "secondary";
  removeButton.classList.add("shelf-remove-button");
  removeButton.textContent = "-";
  removeButton.addEventListener("click", () => removeShelf(wrapper));

  const reorderHandle = document.createElement("button");
  reorderHandle.type = "button";
  reorderHandle.className = "secondary shelf-reorder-handle";
  reorderHandle.textContent = "↕";
  reorderHandle.title = "Drag to reorder shelf";
  reorderHandle.setAttribute("aria-label", "Drag to reorder shelf");
  reorderHandle.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown");
  reorderHandle.draggable = true;
  reorderHandle.addEventListener("dragstart", (event) => {
    draggedShelf = wrapper;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", "shelf");
    wrapper.classList.add("shelf-dragging");
  });
  reorderHandle.addEventListener("dragend", () => {
    draggedShelf = null;
    wrapper.classList.remove("shelf-dragging");
    shelvesEl
      .querySelectorAll(".shelf-wrapper.shelf-drop-target")
      .forEach((item) => item.classList.remove("shelf-drop-target"));
  });
  reorderHandle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const adjacent =
      event.key === "ArrowUp"
        ? wrapper.previousElementSibling
        : wrapper.nextElementSibling;
    if (!adjacent) return;
    event.preventDefault();
    shelvesEl.insertBefore(
      wrapper,
      event.key === "ArrowUp" ? adjacent : adjacent.nextElementSibling,
    );
    reorderHandle.focus();
  });

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "secondary shelf-add-button";
  addButton.textContent = "+";
  addButton.addEventListener("click", () => addShelf(wrapper));

  const shelf = document.createElement("div");
  shelf.className = "shelf";
  shelf.dataset.id = id;
  renderShelfSlots(shelf, slots);

  wrapper.addEventListener("dragover", (event) => {
    if (!draggedShelf || draggedShelf === wrapper) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    wrapper.classList.add("shelf-drop-target");
  });
  wrapper.addEventListener("dragleave", (event) => {
    if (!wrapper.contains(event.relatedTarget)) {
      wrapper.classList.remove("shelf-drop-target");
    }
  });
  wrapper.addEventListener("drop", (event) => {
    if (!draggedShelf || draggedShelf === wrapper) return;
    event.preventDefault();
    const bounds = wrapper.getBoundingClientRect();
    const insertAfter = event.clientY > bounds.top + bounds.height / 2;
    const reference = insertAfter ? wrapper.nextElementSibling : wrapper;
    if (reference !== draggedShelf) {
      shelvesEl.insertBefore(draggedShelf, reference);
    }
    wrapper.classList.remove("shelf-drop-target");
  });

  const actions = document.createElement("div");
  actions.className = "shelf-actions";
  actions.append(removeButton, reorderHandle, addButton);
  wrapper.append(shelf, actions);
  return wrapper;
}

function appendEmptyRow(shelf) {
  const firstIndex = shelf.querySelectorAll(".shelf-slot").length;
  for (let index = 0; index < carsPerRow; index++) {
    const slot = createShelfSlot(firstIndex + index);
    updateSlotState(slot);
    shelf.appendChild(slot);
  }
}

function removeShelf(wrapper) {
  const carCount = wrapper.querySelectorAll(".box").length;
  if (
    carCount > 0 &&
    !confirm(
      `This shelf contains ${carCount} car(s). Remove the shelf and its cars?`,
    )
  ) {
    return;
  }
  wrapper.remove();
}

function openShelfImageDatabase() {
  if (!window.indexedDB) {
    return Promise.reject(new Error("IndexedDB is unavailable in this browser."));
  }
  if (!shelfImageDbPromise) {
    shelfImageDbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(
        SHELF_IMAGE_DB_NAME,
        SHELF_IMAGE_DB_VERSION,
      );
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SHELF_IMAGE_STORE_NAME)) {
          request.result.createObjectStore(SHELF_IMAGE_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("Could not open image storage."));
    }).catch((err) => {
      shelfImageDbPromise = null;
      throw err;
    });
  }
  return shelfImageDbPromise;
}

function readShelfImageBlob(url) {
  return openShelfImageDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(
          SHELF_IMAGE_STORE_NAME,
          "readonly",
        );
        const request = transaction.objectStore(SHELF_IMAGE_STORE_NAME).get(url);
        request.onsuccess = () =>
          resolve(request.result instanceof Blob ? request.result : null);
        request.onerror = () =>
          reject(request.error || new Error("Could not read saved shelf image."));
        transaction.onabort = () =>
          reject(transaction.error || new Error("Image read was interrupted."));
      }),
  );
}

function writeShelfImageBlob(url, blob) {
  return openShelfImageDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(
          SHELF_IMAGE_STORE_NAME,
          "readwrite",
        );
        transaction.objectStore(SHELF_IMAGE_STORE_NAME).put(blob, url);
        transaction.oncomplete = resolve;
        transaction.onerror = () =>
          reject(transaction.error || new Error("Could not save shelf image."));
        transaction.onabort = () =>
          reject(transaction.error || new Error("Image save was interrupted."));
      }),
  );
}

function getShelfImageBlob(url) {
  const pending = shelfImageBlobPromises.get(url);
  if (pending) return pending;

  const promise = (async () => {
    const savedBlob = await readShelfImageBlob(url);
    if (savedBlob) return savedBlob;

    const response = await fetch(url, {
      mode: "cors",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      throw new Error(`Image request failed with HTTP ${response.status}.`);
    }
    const blob = await response.blob();
    if (
      !blob.size ||
      (blob.type && !blob.type.toLowerCase().startsWith("image/"))
    ) {
      throw new Error("The Wiki response was not a usable image.");
    }
    await writeShelfImageBlob(url, blob);
    return blob;
  })().finally(() => shelfImageBlobPromises.delete(url));
  shelfImageBlobPromises.set(url, promise);
  return promise;
}

function getShelfImageObjectUrl(url) {
  const savedObjectUrl = shelfImageObjectUrls.get(url);
  if (savedObjectUrl) return Promise.resolve(savedObjectUrl);
  const pending = shelfImageObjectUrlPromises.get(url);
  if (pending) return pending;

  const promise = getShelfImageBlob(url)
    .then((blob) => {
      const objectUrl = URL.createObjectURL(blob);
      shelfImageObjectUrls.set(url, objectUrl);
      return objectUrl;
    })
    .finally(() => shelfImageObjectUrlPromises.delete(url));
  shelfImageObjectUrlPromises.set(url, promise);
  return promise;
}

function reportShelfImageSaveError(err) {
  console.error("[Tomica Wiki] could not save shelf image locally", err);
  statusEl.textContent = `Could not save shelf image locally: ${err.message}`;
}

function cacheOtherSelectedShelfImages(box, displayedUrl) {
  const images = JSON.parse(box.dataset.images || "[]");
  const selectedIndexes = new Set([
    parseInt(box.dataset.boxImgIdx || "0", 10),
    parseInt(box.dataset.carImgIdx || "0", 10),
  ]);
  const urls = new Set(
    [...selectedIndexes]
      .map((index) => images[index])
      .filter((url) => url && url !== displayedUrl),
  );
  urls.forEach((url) => {
    getShelfImageBlob(url).catch(reportShelfImageSaveError);
  });
}

function renderBoxImage(box) {
  const images = JSON.parse(box.dataset.images || "[]");
  const imageMode = shelfImageMode;
  const indexKey = imageMode === "car" ? "carImgIdx" : "boxImgIdx";
  const selectedIdx = parseInt(box.dataset[indexKey] || "0", 10);
  const legacyIdx = parseInt(box.dataset.imgIdx || "0", 10);
  const idx =
    Number.isInteger(selectedIdx) &&
    selectedIdx >= 0 &&
    selectedIdx < images.length
      ? selectedIdx
      : Number.isInteger(legacyIdx) &&
          legacyIdx >= 0 &&
          legacyIdx < images.length
        ? legacyIdx
        : 0;
  const wrap = box.querySelector(".box-img-wrap");
  const currentSrc = images.at(idx);
  if (currentSrc) {
    const role = imageMode === "box" ? "box art" : "car picture";
    const image = document.createElement("img");
    image.className = "box-img";
    image.src = currentSrc;
    image.referrerPolicy = "no-referrer";
    image.alt = `${box.dataset.name} ${role}`;
    wrap.replaceChildren(image);
    getShelfImageObjectUrl(currentSrc)
      .then((objectUrl) => {
        if (image.isConnected && images.at(idx) === currentSrc) {
          image.src = objectUrl;
        }
      })
      .catch(reportShelfImageSaveError);
    cacheOtherSelectedShelfImages(box, currentSrc);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "no-img";
    placeholder.textContent = "No Wiki Art";
    wrap.replaceChildren(placeholder);
  }
}

function createBoxElement(
  num,
  name,
  type,
  images = [],
  imgIdx = 0,
  options = {},
) {
  const box = document.createElement("div");
  box.className = `box ${type}`;
  box.draggable = true;
  box.dataset.num = num;
  box.dataset.name = name;
  box.dataset.type = type;
  box.dataset.images = JSON.stringify(images);
  const imageTitles =
    Array.isArray(options.imageTitles) &&
    options.imageTitles.length === images.length
      ? options.imageTitles
      : images.map(imageTitleFromUrl);
  const requestedBoxImgIdx = Number.isInteger(options.boxImgIdx)
    ? options.boxImgIdx
    : imgIdx;
  const boxImgIdx =
    requestedBoxImgIdx >= 0 && requestedBoxImgIdx < images.length
      ? requestedBoxImgIdx
      : 0;
  const requestedCarImgIdx = Number.isInteger(options.carImgIdx)
    ? options.carImgIdx
    : defaultCarImageIndex(imageTitles, images.length, boxImgIdx);
  const carImgIdx =
    requestedCarImgIdx >= 0 && requestedCarImgIdx < images.length
      ? requestedCarImgIdx
      : defaultCarImageIndex(imageTitles, images.length, boxImgIdx);
  const imageMode = options.imageMode === "car" ? "car" : "box";
  box.dataset.imageTitles = JSON.stringify(imageTitles);
  box.dataset.boxImgIdx = boxImgIdx;
  box.dataset.carImgIdx = carImgIdx;
  box.dataset.imageMode = imageMode;
  box.dataset.articleTitle = options.articleTitle || "";
  box.dataset.imgIdx = imageMode === "car" ? carImgIdx : boxImgIdx;

  box.innerHTML = `
      <div class="box-top">
        <span class="box-num">${num}</span>
        <div class="box-actions">
          <span class="icon-btn" title="Image Settings" onclick="openImageSettings(this)">⚙</span>
          <span class="icon-btn" title="Delete" onclick="this.closest('.box').remove()">×</span>
        </div>
      </div>
      <div class="box-img-wrap"></div>
      <div class="box-name" title="${name}">${name}</div>
    `;

  renderBoxImage(box);

  box.addEventListener("dragstart", (event) => {
    draggedItem = box;
    draggedArticle = null;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", box.dataset.num);
    setTimeout(() => (box.style.opacity = "0.45"), 0);
  });
  box.addEventListener("dragend", () => {
    if (draggedItem) draggedItem.style.opacity = "1";
    draggedItem = null;
    draggedArticle = null;
    shelvesEl
      .querySelectorAll(".shelf-slot.drag-over")
      .forEach((slot) => slot.classList.remove("drag-over"));
  });

  return box;
}

function updateShelfImageToggle() {
  const showingCarPictures = shelfImageMode === "car";
  shelfImageToggleButton.textContent = showingCarPictures
    ? "Shelf images: Car pictures"
    : "Shelf images: Box art";
  shelfImageToggleButton.setAttribute(
    "aria-pressed",
    String(showingCarPictures),
  );
}

function toggleShelfImageMode() {
  shelfImageMode = shelfImageMode === "box" ? "car" : "box";
  updateShelfImageToggle();
  shelvesEl.querySelectorAll(".box").forEach(renderBoxImage);
  try {
    localStorage.setItem("tomicaShelfImageModeV1", shelfImageMode);
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Could not save shelf image setting: ${err.message}`;
  }
}

let imageSettingsState = null;

function renderImageSettingsList() {
  const state = imageSettingsState;
  const list = document.getElementById("imageSettingsList");
  list.replaceChildren();

  state.images.forEach((url, index) => {
    const option = document.createElement("div");
    option.className = "image-setting-option";

    const image = document.createElement("img");
    image.className = "image-setting-thumbnail";
    image.src = url;
    image.alt = state.imageTitles[index];
    image.referrerPolicy = "no-referrer";
    image.addEventListener(
      "error",
      () => {
        const placeholder = document.createElement("div");
        placeholder.className = "image-setting-thumbnail no-img";
        placeholder.textContent = "Image unavailable";
        image.replaceWith(placeholder);
      },
      { once: true },
    );

    const title = document.createElement("span");
    title.className = "image-setting-title";
    title.textContent = state.imageTitles[index];

    const actions = document.createElement("div");
    actions.className = "image-setting-actions";
    [
      { role: "box", label: "Box art", selectedIndex: state.boxImgIdx },
      {
        role: "car",
        label: "Car picture",
        selectedIndex: state.carImgIdx,
      },
    ].forEach(({ role, label, selectedIndex }) => {
      const button = document.createElement("button");
      const selected = selectedIndex === index;
      button.type = "button";
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.textContent = selected ? `${label} selected` : `Use for ${label}`;
      button.addEventListener("click", () => selectImageForRole(index, role));
      actions.appendChild(button);
    });

    option.append(image, title, actions);
    list.appendChild(option);
  });
}

function selectImageForRole(index, role) {
  const state = imageSettingsState;
  if (!state) return;

  const { box, images, imageTitles, articleTitle } = state;
  box.dataset.images = JSON.stringify(images);
  box.dataset.imageTitles = JSON.stringify(imageTitles);
  box.dataset.articleTitle = articleTitle;
  if (role === "box") {
    state.boxImgIdx = index;
  } else {
    state.carImgIdx = index;
  }
  box.dataset.boxImgIdx = state.boxImgIdx;
  box.dataset.carImgIdx = state.carImgIdx;
  renderBoxImage(box);
  renderImageSettingsList();
  document.getElementById("imageSettingsStatus").textContent =
    `Set "${imageTitles[index]}" as the ${role === "box" ? "box art" : "car picture"}.`;
}

async function openImageSettings(button) {
  const box = button.closest(".box");
  const dialog = document.getElementById("imageSettingsDialog");
  const status = document.getElementById("imageSettingsStatus");
  imageSettingsState = null;
  document.getElementById("imageSettingsTitle").textContent =
    `Image settings: ${box.dataset.num} ${box.dataset.name}`;
  document.getElementById("imageSettingsList").replaceChildren();
  status.textContent = "Loading article images...";
  if (!dialog.open) dialog.showModal();

  try {
    let images = JSON.parse(box.dataset.images || "[]");
    let imageTitles = JSON.parse(box.dataset.imageTitles || "[]");
    let articleTitle = box.dataset.articleTitle || "";
    let warning = "";
    let refreshed = false;
    imageTitles = images.map(
      (url, index) => imageTitles[index] || imageTitleFromUrl(url, index),
    );
    const savedBoxImgIdx = parseInt(
      box.dataset.boxImgIdx || box.dataset.imgIdx || "0",
      10,
    );
    const savedCarImgIdx = parseInt(box.dataset.carImgIdx || "", 10);
    const preferredBoxTitle = imageTitles[savedBoxImgIdx];
    const preferredCarTitle = imageTitles[savedCarImgIdx];

    if (articleTitle || !images.length) {
      const query = articleTitle
        ? wikiArticleUrl(articleTitle)
        : `${box.dataset.num} ${box.dataset.name}`.trim();
      const result = await fetchWikiImages(query, box.dataset.type);
      if (result.images.length) {
        images = result.images;
        imageTitles = result.imageTitles;
        articleTitle = result.title || articleTitle;
        refreshed = true;
      } else if (images.length) {
        warning = `${result.error || "Could not reload article images."} Showing saved images.`;
      } else {
        status.textContent = result.error || "No article images were found.";
        return;
      }
    }

    if (!dialog.open) return;
    imageTitles = images.map(
      (url, index) => imageTitles[index] || imageTitleFromUrl(url, index),
    );
    const preferredBoxIdx = imageTitles.indexOf(preferredBoxTitle);
    const preferredCarIdx = imageTitles.indexOf(preferredCarTitle);
    const storedBoxIdxIsValid =
      Number.isInteger(savedBoxImgIdx) &&
      savedBoxImgIdx >= 0 &&
      savedBoxImgIdx < images.length;
    const storedCarIdxIsValid =
      Number.isInteger(savedCarImgIdx) &&
      savedCarImgIdx >= 0 &&
      savedCarImgIdx < images.length;
    imageSettingsState = {
      box,
      articleTitle,
      images,
      imageTitles,
      boxImgIdx:
        preferredBoxIdx >= 0
          ? preferredBoxIdx
          : !refreshed && storedBoxIdxIsValid
            ? savedBoxImgIdx
            : 0,
      carImgIdx:
        preferredCarIdx >= 0
          ? preferredCarIdx
          : !refreshed && storedCarIdxIsValid
            ? savedCarImgIdx
            : defaultCarImageIndex(imageTitles, images.length),
    };
    status.textContent = warning || "Choose an image for each picture role.";
    renderImageSettingsList();
  } catch (err) {
    console.error(err);
    status.textContent = `Could not load image settings: ${err.message}`;
  }
}

function closeImageSettings() {
  document.getElementById("imageSettingsDialog").close();
  imageSettingsState = null;
}

function wikiArticleUrl(title) {
  return `https://tomica.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

async function addBox(article, addButton, requestedSlot = null) {
  const numInput = document.getElementById("carNum");
  const nameInput = document.getElementById("carName");
  const type = getSelectedBoxType();

  if (!article) {
    statusEl.textContent = "Choose an article from the search results first.";
    return;
  }

  if (requestedSlot?.querySelector(".box")) {
    statusEl.textContent = "Drop the article onto an empty shelf slot.";
    return;
  }

  const rawNum = numInput.value.trim();
  const rawName = nameInput.value.trim();
  selectedArticle = article;
  const title = article.title;
  const articleUrl = wikiArticleUrl(title);
  const idleAddLabel = addButton?.textContent || "Add Box";
  if (addButton) {
    addButton.disabled = true;
    addButton.textContent = "Adding...";
  }
  try {
    const result = await fetchWikiImages(articleUrl, type);
    const match = title.match(/^(?:Premium\s+)?(No\.\s*\d+)\s+(.*)$/i);
    const displayNum = match?.at(1) || rawNum || "No. ?";
    const displayName = match?.at(2) || title || rawName || "Tomica";

    if (requestedSlot && !requestedSlot.isConnected) {
      statusEl.textContent = "The target shelf slot is no longer available.";
      return;
    }
    if (requestedSlot?.querySelector(".box")) {
      statusEl.textContent = "The target shelf slot is no longer empty.";
      return;
    }

    let targetSlot = requestedSlot;
    if (!shelvesEl.querySelector(".shelf")) addShelf();
    if (!targetSlot) {
      const shelves = [...shelvesEl.querySelectorAll(".shelf")];
      let targetShelf = shelves.find((shelf) =>
        shelf.querySelector(".shelf-slot.empty"),
      );
      if (!targetShelf) {
        targetShelf = shelves[0];
        appendEmptyRow(targetShelf);
      }
      targetSlot = targetShelf.querySelector(".shelf-slot.empty");
    }
    targetSlot.appendChild(
      createBoxElement(displayNum, displayName, type, result.images, 0, {
        articleTitle: title,
        imageTitles: result.imageTitles,
      }),
    );
    updateSlotState(targetSlot);
    numInput.value = "";
    nameInput.value = "";
    articleResultsEl.querySelectorAll(".article-option").forEach((item) => {
      item.classList.toggle("selected", item.dataset.articleTitle === title);
    });
    statusEl.textContent = `Added "${displayName}" to your shelf.`;
  } finally {
    if (addButton?.isConnected) {
      addButton.disabled = false;
      addButton.textContent = idleAddLabel;
    }
  }
}

["carNum", "carName"].forEach((id) => {
  document.getElementById(id).addEventListener("input", clearArticleSelection);
  document.getElementById(id).addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      searchWikiArticles();
    }
  });
});
function addShelf(afterShelf = null) {
  const newShelf = createShelf(Date.now());
  if (afterShelf?.parentElement === shelvesEl) {
    afterShelf.after(newShelf);
  } else {
    shelvesEl.appendChild(newShelf);
  }
}
function getLayoutData() {
  return [...shelvesEl.querySelectorAll(".shelf")].map((shelf) =>
    [...shelf.querySelectorAll(".shelf-slot")].map(getSlotData),
  );
}

function getLayoutState() {
  return { carsPerRow, shelves: getLayoutData() };
}

function updateCarsPerRow() {
  const nextCount = Number(carsPerRowInput.value);
  if (!Number.isInteger(nextCount) || nextCount < 1 || nextCount > 20) {
    carsPerRowInput.value = carsPerRow;
    statusEl.textContent = "Cars per row must be between 1 and 20.";
    return;
  }
  if (nextCount === carsPerRow) return;

  const shelves = getLayoutData();
  carsPerRow = nextCount;
  carsPerRowInput.value = carsPerRow;
  [...shelvesEl.querySelectorAll(".shelf")].forEach((shelf, index) => {
    renderShelfSlots(shelf, shelves[index]);
  });
  recordLayoutChange();
}

carsPerRowInput.addEventListener("change", updateCarsPerRow);

function cloneLayout(layout) {
  return JSON.parse(JSON.stringify(layout));
}

function carLabel(car) {
  return [car.num, car.name].filter(Boolean).join(" ") || "car";
}

function describeLayoutChange(previousState, currentState) {
  if (previousState.carsPerRow !== currentState.carsPerRow) {
    return `Changed cars per row to ${currentState.carsPerRow}`;
  }

  const previous = previousState.shelves;
  const current = currentState.shelves;
  const previousCars = previous.flat();
  const currentCars = current.flat();
  const occupiedPrevious = previousCars.filter(Boolean);
  const occupiedCurrent = currentCars.filter(Boolean);
  const carDelta = occupiedCurrent.length - occupiedPrevious.length;
  const shelfDelta = current.length - previous.length;

  if (carDelta > 0) {
    const addedCar =
      occupiedCurrent.find(
        (car) =>
          !occupiedPrevious.some(
            (oldCar) => oldCar.num === car.num && oldCar.name === car.name,
          ),
      ) || occupiedCurrent.at(-1);
    return `Added ${carLabel(addedCar)}`;
  }
  if (shelfDelta < 0) return "Removed shelf";
  if (carDelta < 0) {
    const removedCar =
      occupiedPrevious.find(
        (car) =>
          !occupiedCurrent.some(
            (newCar) => newCar.num === car.num && newCar.name === car.name,
          ),
      ) || occupiedPrevious.at(-1);
    return `Removed ${carLabel(removedCar)}`;
  }
  if (shelfDelta > 0) return "Added shelf";

  const sortedPreviousShelves = previous
    .map((shelf) => JSON.stringify(shelf))
    .sort();
  const sortedCurrentShelves = current
    .map((shelf) => JSON.stringify(shelf))
    .sort();
  if (
    JSON.stringify(previous) !== JSON.stringify(current) &&
    JSON.stringify(sortedPreviousShelves) ===
      JSON.stringify(sortedCurrentShelves)
  ) {
    return "Reordered shelves";
  }

  const previousPlacement = previous.map((shelf) =>
    shelf.map((car) => (car ? [car.num, car.name, car.type] : null)),
  );
  const currentPlacement = current.map((shelf) =>
    shelf.map((car) => (car ? [car.num, car.name, car.type] : null)),
  );
  if (JSON.stringify(previousPlacement) !== JSON.stringify(currentPlacement)) {
    return "Moved car";
  }

  for (let shelfIndex = 0; shelfIndex < current.length; shelfIndex++) {
    for (let carIndex = 0; carIndex < current[shelfIndex].length; carIndex++) {
      const previousCar = previous[shelfIndex][carIndex];
      const currentCar = current[shelfIndex][carIndex];
      if (!previousCar || !currentCar) continue;
      if (
        previousCar.imgIdx !== currentCar.imgIdx ||
        previousCar.boxImgIdx !== currentCar.boxImgIdx ||
        previousCar.carImgIdx !== currentCar.carImgIdx ||
        previousCar.imageMode !== currentCar.imageMode ||
        previousCar.articleTitle !== currentCar.articleTitle ||
        JSON.stringify(previousCar.images) !==
          JSON.stringify(currentCar.images) ||
        JSON.stringify(previousCar.imageTitles) !==
          JSON.stringify(currentCar.imageTitles)
      ) {
        return `Changed image for ${carLabel(currentCar)}`;
      }
    }
  }

  return "Updated layout";
}

function restoreLayout(state) {
  carsPerRow = state.carsPerRow;
  carsPerRowInput.value = carsPerRow;
  shelvesEl.replaceChildren();
  state.shelves.forEach((slots, shelfIndex) => {
    shelvesEl.appendChild(createShelf(Date.now() + shelfIndex, slots));
  });
}

function undoLastAction() {
  if (historyMode === "undo" && !undoLayout) return;
  if (historyMode === "redo" && !redoLayout) return;

  const targetLayout = cloneLayout(
    historyMode === "undo" ? undoLayout : redoLayout,
  );
  clearTimeout(layoutSaveTimeout);
  if (historyMode === "undo") {
    redoLayout = cloneLayout(getLayoutState());
    restoreLayout(targetLayout);
    undoLayout = null;
    historyMode = "redo";
    undoButton.textContent = "Redo";
    lastActionButton.textContent = `Last action: Undid ${lastActionDescription}`;
  } else {
    undoLayout = cloneLayout(getLayoutState());
    restoreLayout(targetLayout);
    redoLayout = null;
    historyMode = "undo";
    undoButton.textContent = "Undo";
    lastActionButton.textContent = `Last action: ${lastActionDescription}`;
  }
  lastObservedState = cloneLayout(targetLayout);
  lastActionButton.title = lastActionButton.textContent;
  persistLayout(targetLayout);
}

function persistLayout(state = getLayoutState()) {
  try {
    localStorage.setItem("tomicaWikiLayoutV3", JSON.stringify(state.shelves));
    localStorage.setItem("tomicaCarsPerRowV1", String(state.carsPerRow));
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Could not auto-save layout: ${err.message}`;
  }
}

function parseImportedLayout(value) {
  const isLegacyLayout = Array.isArray(value);
  const shelves = isLegacyLayout ? value : value?.shelves;
  const rowWidth = isLegacyLayout
    ? carsPerRow
    : Number(value?.carsPerRow ?? carsPerRow);
  if (!Array.isArray(shelves)) {
    throw new Error("The JSON must contain an array of shelves.");
  }
  if (!Number.isInteger(rowWidth) || rowWidth < 1 || rowWidth > 20) {
    throw new Error("Cars per row must be between 1 and 20.");
  }
  const boxTypes = new Set(["standard", "long", "premium"]);
  const parsedShelves = shelves.map((shelf, shelfIndex) => {
    if (!Array.isArray(shelf)) {
      throw new Error(`Shelf ${shelfIndex + 1} must be an array.`);
    }
    const parsedSlots = shelf.map((box, boxIndex) => {
      if (box === null) return null;
      if (
        !box ||
        typeof box.num !== "string" ||
        typeof box.name !== "string" ||
        !boxTypes.has(box.type)
      ) {
        throw new Error(
          `Car ${boxIndex + 1} on shelf ${shelfIndex + 1} has invalid number, name, or type.`,
        );
      }

      const images = box.images ?? [];
      const imgIdx = box.imgIdx ?? 0;
      if (
        !Array.isArray(images) ||
        !images.every((image) => typeof image === "string")
      ) {
        throw new Error(
          `Car ${boxIndex + 1} on shelf ${shelfIndex + 1} has invalid images.`,
        );
      }
      const imageTitles = box.imageTitles ?? images.map(imageTitleFromUrl);
      if (
        !Array.isArray(imageTitles) ||
        imageTitles.length !== images.length ||
        !imageTitles.every((title) => typeof title === "string")
      ) {
        throw new Error(
          `Car ${boxIndex + 1} on shelf ${shelfIndex + 1} has invalid image titles.`,
        );
      }
      const boxImgIdx = box.boxImgIdx ?? imgIdx;
      const carImgIdx =
        box.carImgIdx ??
        defaultCarImageIndex(imageTitles, images.length, boxImgIdx);
      const imageMode = box.imageMode ?? "box";
      const articleTitle = box.articleTitle ?? "";
      if (
        !Number.isInteger(imgIdx) ||
        imgIdx < 0 ||
        (images.length === 0 ? imgIdx !== 0 : imgIdx >= images.length)
      ) {
        throw new Error(
          `Car ${boxIndex + 1} on shelf ${shelfIndex + 1} has an invalid image index.`,
        );
      }
      for (const index of [boxImgIdx, carImgIdx]) {
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          (images.length === 0 ? index !== 0 : index >= images.length)
        ) {
          throw new Error(
            `Car ${boxIndex + 1} on shelf ${shelfIndex + 1} has an invalid image role index.`,
          );
        }
      }
      if (
        !["box", "car"].includes(imageMode) ||
        typeof articleTitle !== "string"
      ) {
        throw new Error(
          `Car ${boxIndex + 1} on shelf ${shelfIndex + 1} has invalid image settings.`,
        );
      }

      return {
        num: box.num,
        name: box.name,
        type: box.type,
        images: [...images],
        imageTitles: [...imageTitles],
        imgIdx,
        boxImgIdx,
        carImgIdx,
        imageMode,
        articleTitle,
      };
    });
    return normalizeShelfSlots(parsedSlots, rowWidth);
  });
  return { carsPerRow: rowWidth, shelves: parsedShelves };
}

function openImportDialog() {
  document.getElementById("importStatus").textContent = "";
  document.getElementById("importDialog").showModal();
}

function closeImportDialog() {
  document.getElementById("importDialog").close();
}

function applyImportedLayoutJson(jsonText) {
  try {
    const state = parseImportedLayout(JSON.parse(jsonText));
    if (JSON.stringify(state) === JSON.stringify(getLayoutState())) {
      const message = "The imported layout is already current.";
      statusEl.textContent = message;
      document.getElementById("importStatus").textContent = message;
      return false;
    }
    if (
      !confirm(
        "Importing this layout will replace your current shelves and cars. Continue?",
      )
    ) {
      return false;
    }

    clearTimeout(layoutSaveTimeout);
    undoLayout = cloneLayout(getLayoutState());
    redoLayout = null;
    historyMode = "undo";
    undoButton.textContent = "Undo";
    undoButton.disabled = false;
    lastActionDescription = "Imported layout";
    lastActionButton.textContent = `Last action: ${lastActionDescription}`;
    lastActionButton.title = lastActionButton.textContent;
    restoreLayout(state);
    lastObservedState = cloneLayout(state);
    persistLayout(state);
    statusEl.textContent = "Layout imported.";
    document.getElementById("importStatus").textContent = "";
    document.getElementById("importJson").value = "";
    closeImportDialog();
    return true;
  } catch (err) {
    console.error(err);
    const message = `Layout import failed: ${err.message}`;
    statusEl.textContent = message;
    document.getElementById("importStatus").textContent = message;
    return false;
  }
}

function importLayoutText() {
  const jsonText = document.getElementById("importJson").value.trim();
  if (!jsonText) {
    document.getElementById("importStatus").textContent =
      "Paste layout JSON before importing.";
    return;
  }
  applyImportedLayoutJson(jsonText);
}

async function importLayoutFile(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;

  try {
    applyImportedLayoutJson(await file.text());
  } catch (err) {
    console.error(err);
    const message = `Layout import failed: ${err.message}`;
    statusEl.textContent = message;
    document.getElementById("importStatus").textContent = message;
  } finally {
    input.value = "";
  }
}

function exportLayout() {
  document.getElementById("exportJson").value = JSON.stringify(
    getLayoutState(),
    null,
    2,
  );
  document.getElementById("exportStatus").textContent = "";
  document.getElementById("exportDialog").showModal();
}

function closeExportDialog() {
  document.getElementById("exportDialog").close();
}

async function copyExportJson() {
  const exportJson = document.getElementById("exportJson");
  const exportStatus = document.getElementById("exportStatus");
  try {
    await navigator.clipboard.writeText(exportJson.value);
    exportStatus.textContent = "JSON copied to clipboard.";
  } catch (err) {
    console.error(err);
    exportJson.focus();
    exportJson.select();
    exportStatus.textContent = `Could not copy automatically: ${err.message}. Select the JSON and copy it manually.`;
  }
}

function downloadExportJson() {
  const exportJson = document.getElementById("exportJson").value;
  const blob = new Blob([exportJson], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "tomica-layout.json";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  document.getElementById("exportStatus").textContent =
    "JSON download started.";
}

const saved = JSON.parse(localStorage.getItem("tomicaWikiLayoutV3") || "null");
if (saved !== null) {
  restoreLayout(parseImportedLayout(saved));
} else {
  addShelf();
  addShelf();
}
updateShelfImageToggle();
renderArticleResults([], { state: "default" });

function recordLayoutChange() {
  const currentState = getLayoutState();
  if (JSON.stringify(currentState) === JSON.stringify(lastObservedState)) {
    return;
  }

  undoLayout = cloneLayout(lastObservedState);
  redoLayout = null;
  historyMode = "undo";
  const description = describeLayoutChange(lastObservedState, currentState);
  lastActionDescription = description;
  lastActionButton.textContent = `Last action: ${description}`;
  lastActionButton.title = lastActionButton.textContent;
  undoButton.textContent = "Undo";
  undoButton.disabled = false;
  lastObservedState = cloneLayout(currentState);

  clearTimeout(layoutSaveTimeout);
  layoutSaveTimeout = setTimeout(() => persistLayout(currentState), 150);
}

lastObservedState = cloneLayout(getLayoutState());
const layoutObserver = new MutationObserver(recordLayoutChange);
layoutObserver.observe(shelvesEl, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: [
    "data-images",
    "data-image-titles",
    "data-img-idx",
    "data-box-img-idx",
    "data-car-img-idx",
    "data-image-mode",
    "data-article-title",
  ],
});
persistLayout(lastObservedState);
