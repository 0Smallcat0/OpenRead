# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.21.0] - 2026-08-14

### Added

- **EPUBs open in a reader of their own.** An `.epub` is a zip of XHTML, so a
  book is now read the same way a web page is: chapter in the document, the
  translation under each paragraph, selection and the hover key working
  unchanged. Open one from the popup's **Open an EPUB…**, or drop the file onto
  the reader. Contents, Next and Previous, and the reading position remembered
  per book — keyed on the publisher's identifier, so the same book opened from
  a different folder is still the same book.

  Ask for a translation once and it follows you through the book. A chapter
  break is not a decision, and a reader who had to press the button again at
  every one would be pressing it dozens of times.

  Deliberately not paginated. Every other browser EPUB reader reflows the text
  into columns, and that means owning the layout — which cannot survive
  whole-page translation, since inserting a line under every paragraph changes
  the height of the chapter as it is translated. A paginator would re-break the
  whole book underneath the reader's eyes each time a translation landed; a
  scrolling document simply grows. That one choice is why `ui/blocks.ts`,
  `ui/fullpage.ts` and `ui/selection.ts` all work here with no reader-specific
  code at all.

- **A zip reader, with no dependency added.** `core/zip.ts` parses the archive
  and hands the compressed bytes to `DecompressionStream('deflate-raw')` —
  which is the same inflate a zip library bundles, already in the browser. What
  a library would have added is the container format: an
  end-of-central-directory record, a table of file headers, and the arithmetic
  to find where each entry begins. That is fully specified, it is unit tested
  against archives built in the test, and it is a better trade than another
  dependency inside a Chrome Web Store package. The central directory is read
  rather than the local headers, because a streaming producer writes zeroes
  into the local header's size fields and a reader that trusts them hands back
  an empty chapter.

- **`pnpm e2e:epub` — the reader, in a real Chrome, on a real archive.** jsdom
  has no `DecompressionStream` behind a real zip, no `URL.createObjectURL`, no
  layout for an image to have a size in, and no network stack to prove nothing
  was fetched over it. The harness builds the book with Node's own `zlib`, so
  the producing side is a genuinely independent implementation, then asserts
  the chapters, a nested table of contents, an image rendered from inside the
  archive, a link the book drew, the remembered position, a bilingual
  translation from the real engine, that it follows into the next chapter — and
  that reading a whole book made **no network request of any kind**.

  Checked by hand against Project Gutenberg's Moby-Dick (812 KB, EPUB 3): opens
  in 21 ms, 146 contents entries, an SVG cover resolved through `xlink:href`,
  and one 108,000-character chapter whose 391 blocks the viewport-first queue
  translates as the reader reaches them.

### Fixed

Seven ways this extension could look broken on a computer it had just been
installed on. All four were found by `pnpm e2e:first-run`, a new harness that
loads the build into a profile that has never translated anything, and reports
what Chrome offered, what the popup said, and what pressing the button
produced. Every other harness here deliberately reuses a warm profile, which
left the first five minutes after a Web Store install untested.

- **The Firefox build could not translate anything, and said nothing about
  it.** `declarativeNetRequest` does not exist in Firefox's MV2, which is the
  build Firefox gets — so the call that installs the Origin-strip rule threw at
  start-up, `originRuleReady` became a rejected promise, and every request
  begins by awaiting it *outside* its try. The rejection escaped the handler
  entirely: nothing was posted back to the port, so a translation sat there
  running forever with no error to show. Firefox's only engine is Ollama, so
  that silence was the whole product, since 2.5.0. Now guarded, and the
  permission is no longer asked for on Firefox — it bought an install warning
  for an API the build cannot use. Held by a test that returns an empty
  transcript if the guard is removed.

- **A slow PDF translated its first page twice.** A page is marked translated
  when it *finishes*, and the queue refills from "every drawn page that is not
  marked" — so a page still being translated looked to every refill like a page
  nobody had taken, and a second worker took it. The window is milliseconds on
  a warm profile, which is why four releases of harness runs never saw it, and
  the length of a language-pack download on the first PDF anyone opens: two
  translations under one page, and twice the model work to produce them. Caught
  by `pnpm e2e:page` on a cold profile — the second block's previous sibling was
  the first block rather than a page — and now held by a unit test that fails
  without the fix. `ui/fullpage.ts` has carried the same guard, for the same
  reason, since the web-page path hit this first.

- **A language-pack download that never started waited forever.** There was no
  timeout anywhere on the built-in engine's path, and `Translator.create()` has
  none of its own, so a download Chrome's component updater never gets going —
  too little free disk space, a connection Chrome treats as metered, a network
  that blocks the updater — left the badge reading _"Downloading language
  pack…"_ for as long as the tab stayed open. Reported from a fresh install on
  a freshly downloaded Chrome, which is exactly where it bites. Three minutes
  of **no progress at all** now ends the attempt and says what to check. It
  measures silence rather than total time: a real download can legitimately say
  nothing for 81 seconds — measured, on `en`→`ko`, which reported exactly two
  progress events for the whole fetch — so a total timeout would cancel working
  downloads to catch dead ones.

- **The one message that explained everything erased itself after 2.5
  seconds.** On a browser with no built-in translator and no Ollama running,
  OpenRead diagnoses itself correctly — _"This browser has no built-in
  translator (Chrome 138+ does). OpenRead fell back to Ollama, which also
  failed"_ — and then took that sentence off the screen, along with every
  failure marker, leaving a page that looked exactly like one nobody had
  pressed the button on. Traced in the harness: started, failed, explained
  itself and cleaned up inside six seconds. A finish message that reports a
  failure now stays until dismissed; a clean `Done — 34 translated` still takes
  itself away, because it reports something the reader can already see.

- **The popup said everything was fine on a browser that could not translate a
  word.** `packAvailability` answered `null` both for "this browser has no
  translator" and for "could not ask", and the popup answered `null` by hiding
  the whole banner, with a comment reading _"the engine note covers that"_. The
  engine note is a fixed sentence saying there is nothing to install. The two
  cases are now told apart, and the first one says: _this browser has no
  built-in translator, so nothing here will work until you update to Chrome 138
  or later — or switch the translator to Ollama_.

- **On the Chrome Web Store page, pressing translate did nothing and said
  nothing.** Chrome forbids every extension from running there — which is a
  problem because the Web Store listing is the page every new user is looking
  at the moment they install. The popup now names the restriction before the
  press and disables the button, rather than letting it be delivered to nobody.

- **A tab that was already open when the extension was installed has no content
  script in it**, so the button closed the popup and changed nothing. That
  failure was explicitly swallowed, with the comment _"nothing to report — the
  popup is closing either way"_. It now stays open and says to reload the page.
  A page whose address Chrome will not even show the extension gets a different
  sentence, because "reload the page" is advice that cannot work there.

- **A copy-protected book opened, and rendered a page of mojibake.** A DRM
  EPUB is a well-formed EPUB whose chapters are ciphertext, so every check
  passed and the reader painted the encrypted bytes. Most books bought from a
  shop are like this. It now says so — which is the whole of what can be done,
  since the key is not in the file.

### Security

- **A chapter is treated as what it is: XHTML written by someone else, being
  rendered on an extension page.** Script elements, `on…` handlers and
  `javascript:` URLs are removed, on top of the page's content security policy
  rather than instead of it. Remote references — an image, a stylesheet, a
  `background-image: url(…)` in an inline style — are dropped rather than
  fetched, because a remote resource in a book is a request the reader did not
  make and a note to the publisher about which page they are on. The
  specification requires everything a book needs to be inside the archive, so
  nothing legitimate is lost.

## [2.20.0] - 2026-08-08

### Added

- **An article inside an iframe is translated too.** Whole-page translation ran
  on the top frame only, which kept ad iframes from spending the reader's GPU
  and kept one progress badge on the page — and left embedded documents,
  comment systems and syndicated posts untranslated with nothing on screen to
  say why. The test is now what is in the frame rather than where it sits:
  three translatable blocks, plus a 200×200 floor for tracking pixels. The
  floor is not the defence and is not meant to be — a 300×600 skyscraper ad
  clears it, and the block count is what keeps it out.

- **`srcdoc` frames get a content script.** They have no URL of their own to
  match against, so `<all_urls>` never applied and Chrome injected nothing.
  Measured on MDN, whose examples are these: seven paragraphs of prose in one
  of them with nothing there to translate it.

- **The default engine finally has a score.** Every quality number this project
  published was measured on the Ollama path; Chrome's built-in translator is
  what almost everyone is served by and nothing in `eval/` mentioned it.
  `pnpm eval:builtin` runs a real browser with the built extension and drives
  translations through the extension's own broker, over the same 27 fixtures
  and the same chrF as the model benchmark. It scores **36.5** against qwen3's
  46.4 — ten chrF is the price of installing nothing, and a whole segment
  finishes in 20 ms while qwen3 takes 451 ms to paint its first character. Full
  report in [`eval/BUILTIN-RESULTS.md`](eval/BUILTIN-RESULTS.md).

  It also found that the one quality layer the default engine has,
  `toTaiwanVocabulary`, rewrote 1 of 27 segments. The table was built by
  counting 32 substitutions in one translated article, and that article was
  software documentation. Both measurements are true; the finding is that the
  corpus this project scores translation quality on barely covers the domain
  its one quality layer exists for.

### Fixed

- **A sentence about a piece of code came back without the code in it.** On
  MDN, "…redefined as `allow="fullscreen"`." became "…重新定義為 。" — a full
  stop after a space, with the thing the sentence was about silently gone.
  `code`, `kbd` and `samp` are on the skip list and have been since the start,
  and that was one decision being read as two: leaving code out of what is
  _sent_ is right, leaving it out of what is _shown_ is not, and nobody ever
  chose it. Inline code now goes in as a placeholder and comes back as itself.

- **A paper on arXiv is a PDF.** Routing decided from the address, and an
  address is a guess: arxiv.org serves every paper from `/pdf/1706.03762`, with
  no extension anywhere in it, so the best-known source of papers on the
  internet landed in Chrome's own viewer where this extension can see no text
  at all. The tab now says what it is rendering, from `document.contentType`,
  which is not a guess.

- **Switching target language no longer empties the page while a model
  downloads.** One press cleared the translation that was there, and the first
  request in the new language is also the one that makes Chrome fetch a
  language pack — up to two minutes of a bare page with a progress badge on
  it, which is indistinguishable from broken. The old translation now stays up
  until the engine can answer, and pressing Stop during the wait keeps it.

- **The language detector downloads a model too, and nobody was told.**
  `LanguageDetector.availability()` answers `downloadable` on a profile that
  has never used it and `create()` then does not resolve for minutes. Every
  request that omits a source language waits on that — the text box, a whole
  PDF, any page with no `<html lang>` — in complete silence, so the extension
  looked dead from every surface at once while translation itself was fine.
  The detector is created once and shared rather than per call, and its
  download is reported through the same channel the translation pack's is.

### Withdrawn

- **Subtitle translation was built and taken out again before release.** It
  worked on a player-shaped fixture and produced six different symptoms on a
  real one — position, size, overflow past the video, the caption shuddering,
  a blink on every cue, a line over the control bar — because it scraped the
  rendered caption DOM per cue and tried to place a second line beside it. That
  is a fight with the player's renderer, and the established tools do not have
  it: they fetch the whole subtitle track, translate the cue list, and hand the
  player bilingual cue text so it renders both lines as one of its own
  captions. Shipping six fixes on the wrong foundation would have produced a
  seventh. A track-level rewrite starts from an empty file.

## [2.19.0] - 2026-08-07

### Added

- **A glossary: the names a translator keeps getting wrong.** In the popup, one
  a line. `OpenRead` on its own keeps the name exactly as written wherever it
  appears; `widget = 小工具` pins how a term is rendered every time. Chrome's
  built-in translator takes no prompt — it takes a string and returns a string
  — so there is nothing to instruct, and the term is instead held out of the
  sentence and put back afterwards.

  Which only works if the placeholder survives the round trip, and that is a
  fact about a model rather than about this code, so it was measured rather
  than guessed: eight placeholder shapes, four sentences each, against a real
  Chrome, into nine target languages.

  The obvious choice was wrong. `⟦0⟧` came back intact 6/6 into Chinese,
  Japanese, Korean, Spanish and German — and then 0/4 into Arabic, which eats
  the brackets and leaves a bare digit standing in the sentence; 2/4 into
  Hindi; 1/4 into Thai. `#0#` is respaced to `# 0 #` in Arabic and `%%0%%` has
  its percent signs translated to `٪`. `〔0〕` is translated into `「0」` by
  Chinese. A private-use character is dropped outright. And a letter run is a
  word, so words get changed: `OITT0Z` came back from Hebrew as `OITTT0Z`.
  Three shapes survived every language tested; `[[0]]` is the one of those that
  is neither a format string nor a word.

  A placeholder that does not come back leaves the term missing from the
  sentence, which is worse than having translated it, so that case translates
  again without protection rather than shipping a hole.

  Streaming is given up only for the blocks a glossary actually touches, since
  a chunk boundary can land inside a placeholder. Everything else streams as
  before.

### Fixed

- The store submission guide, the rebuild plan and the README each described an
  older repository than this one — a store kit dated to before its copy and
  screenshots were redone, a re-shoot still listed as outstanding after it had
  happened, and a test count two behind. The guide also gained the step it was
  missing: for an item that already exists the upload is on the **Package**
  tab, and the Store listing tab has no upload control anywhere on it.

- A test that measured nothing. "Does not protect a block that is nothing but
  the term" recorded only the last text the engine saw, and the unprotected
  retry is the last text the engine sees — so it passed with the guard it
  covers removed. It records every call now, and goes red when the guard goes.

## [2.18.1] - 2026-08-07

### Fixed

- **Whole-page translation had no working keyboard shortcut, and had not for
  several releases.** `Ctrl+Shift+L` was chosen when `Ctrl+Shift+G` turned out
  to be Chrome's "find previous"; asking `chrome.commands.getAll()` now shows
  Chrome silently declines to bind `L` as well. Chrome answers a suggested key
  it reserves by leaving the command unassigned, with the manifest still
  reading correctly and nothing anywhere saying so. It is `Ctrl+Shift+U` now,
  and `pnpm e2e:page` asks Chrome what it actually bound rather than trusting
  the manifest — the only way this class of bug is visible at all.

- **Selecting a translation offered to translate the translation.** Dragging
  across an inserted translation — to copy it, which is the obvious thing to do
  with one — put the 文 icon over it. `blocks.ts` has said since the beginning
  that this extension's UI must never become input to itself; the selection
  path did not honour it. Reported from use on a translated PDF, where the
  panel is the only thing worth selecting, and it applied equally to a
  translated web page and to the translation panel itself.

- **Centred headings in a PDF were split into fragments and translated
  separately.** Paragraph breaks were inferred partly from how far a line's
  left edge moved, and a centred title moves its left edge by however much the
  lines differ in width — measured at 157px against 462px between the two lines
  of one title on the viewer's sample paper. So every centred heading, author
  list and affiliation came apart. Lines are now compared by horizontal
  overlap, which gets both cases right for the same reason: centred lines
  overlap heavily however their edges move, and the second column of a
  two-column page does not overlap the first at all.

- **Selecting text and translating it claimed the page's language for text the
  page did not write.** The same defect as the one fixed for text boxes in
  2.17.0, one path over. Typing Chinese into a box on a page that declares
  `lang="en"` and asking for English handed the engine "translate this English
  into English", so it returned the Chinese verbatim. A selection inside an
  input, a textarea or a contenteditable now goes without a source language and
  lets the engine work it out; a selection of the page's own text still carries
  `<html lang>`, which is the hint that keeps short captions from being
  detected wrongly.

- **Selecting a PDF translation highlighted nothing, so it looked unselectable.**
  It was selected the whole time. The vendored viewer carries an OpenRead patch
  setting a global transparent `::selection`, re-enabled only inside
  `.textLayer`, so the text layer and the canvas beneath it do not both render
  the highlight — and this panel is neither. It has its own selection colour
  now. Reported as "I cannot select the translation", and a real mouse drag
  had been pulling 1,891 characters out of it the entire time.

- **The PDF translation panel is the width of its page, and its text is not.**
  It was a fixed column, which read as a separate document floating beside the
  paper; making it match the page put 130 characters on a line and produced a
  wall of text. The block matches the page so it belongs to the document, and
  the paragraphs inside hold a readable measure. `box-sizing` too — the inline
  width is the page's, and `content-box` had been laying 20px of padding over
  each edge of the paper.

- **A first PDF said nothing while it waited for a language pack.** The page
  path has reported that download since 2.15.0, whose entry reads "two minutes
  of silence on the first use of a language pair is the bug this replaces" —
  and the PDF path, added three versions later, never passed the callback. The
  same two minutes of silence, one surface over: a fresh profile sat at
  "Translating 0/2" with nothing else said. It reports the download now.

  Found only because `pnpm e2e:page` runs on a throwaway profile. On a warm one
  the pack is already there and this is invisible, which is exactly the profile
  every hand-check and every quick verification had used.

- **`pnpm e2e:stress` hardcoded one developer's profile directory.** It could
  not run anywhere else, and two runs on this machine shared state — which a
  stress harness is the last place to want. A throwaway profile by default, like
  the other two. Its PDF wait is also seven minutes now, and prints elapsed time
  every minute: 120 seconds of a first-run download looked exactly like a hang,
  and telling those apart has already cost three wrong diagnoses.

- **Translating what you have typed is on the right-click menu.** It was
  reachable only by `Ctrl+Shift+K`, and a command is reachable exactly as far
  as Chrome's willingness to bind its key — which is neither documented nor
  stable, as `translate-page` demonstrated by shipping unbound for several
  releases. A feature with one route in has none the day that route fails.

- **The PDF translation panel says it is selectable rather than inheriting
  whatever the viewer decided.** It sits inside the viewer's own container, and
  a translation nobody can copy out is half a feature. `pnpm e2e:page` now
  drags across it with the mouse rather than selecting it through the DOM,
  because only the drag exercises what a reader actually does.

## [2.18.0] - 2026-08-07

### Added

- **Whole-document translation in the bundled PDF viewer.** The refusal this
  replaces was right about the constraint and wrong about the conclusion. A PDF
  text layer really is absolutely-positioned spans laid over a rendered page,
  and a translation appended under a line really would land on the next one —
  but the pages themselves are ordinary block elements stacked in `#viewer`, so
  a translation placed _after a page_ costs nothing. It reads in order: the
  page as the author laid it out, then that page in your language, then the
  next page.

  Which is also how a paper is read. Nobody wants a two-column PDF reflowed
  into one; they want to see the figure and read the argument.

  The same control as everywhere else — right-click, the popup button, or
  `Ctrl+Shift+L` — and pressing it again puts the document back.

  Pages render lazily, measured at 2 of 14 with a text layer at any moment, so
  this follows the viewer rather than making one pass: the page nearest the
  reader is translated first, and pages the viewer draws later are picked up as
  they arrive.

  Paragraphs are recovered from geometry, but less of it than expected. PDF.js
  already emits `<br>` between lines, so the line breaks are given and only the
  paragraph breaks have to be inferred — and those are inferred from line
  _pitch_, top to top, compared against the median pitch of that page. Not the
  gap between line boxes: this extension pads every span by 5px a side to make
  lines easier to grab, so on a real page the measured gaps run negative — -8,
  -9, -2 down a column of ordinary prose. Pitch is untouched by symmetric
  padding, and a per-page median calibrates itself to the font size and the
  zoom instead of being right at one of them.

  Verified on the viewer's own sample paper, a two-column PLDI submission: 41
  paragraphs off the first two pages, every translation placed after its page,
  and pressing again leaving the document as it was.

## [2.17.0] - 2026-08-06

### Changed

- **Releases publish to npm through trusted publishing, with no token at all.**
  GitHub mints a short-lived OIDC token for the release workflow, npm checks it
  against a publisher rule naming this repository and this workflow file, and
  the provenance attestation is attached automatically — the `--provenance`
  flag is not needed and neither is `NPM_TOKEN`.

  Forced by this release. `npm publish --provenance` with a token failed twice
  on `IDENTITY_TOKEN_READ_ERROR`, having worked two hours earlier for 2.16.0.
  The secret it removes was also due to expire on 2026-11-03, so the fix and
  the chore were the same piece of work.

  Node 22 ships npm 10; trusted publishing wants 11.5.1 or later, so the
  workflow now installs it explicitly rather than failing on an npm that has
  never heard of OIDC.

### Fixed

- **The release workflow can be retried.** It could not: a run that got past
  the GitHub release and then failed — which is exactly what happened to
  v2.17.0 — died on "a release with the same tag name already exists" on every
  retry, before ever reaching the step that had actually failed. Publishing the
  release is idempotent now: it edits and re-uploads when the release is
  already there.

### Added

- **Translate the box you are typing in.** `Ctrl+Shift+K`, and whatever is in
  the focused field is replaced with its translation. The other direction from
  everything else here: the rest answers "what does this page say", this answers
  "how do I say this" — a reply, a commit message, a bug report, written in the
  language the writer thinks in and needed in the language the reader wants.

  Its own target language, set separately in the popup and defaulting to
  English, because `targetLang` is the language you _read_ in and nobody writes
  a reply to an English forum in the language they read English into.

  The interesting problem is not the translation. It is replacing text in a
  field without breaking the page around it. Assigning to `value` fires no
  `input` event, so React and Vue never learn the field changed and revert it on
  the next render — and it wipes the browser's undo stack, so the writer cannot
  take back a translation they did not like. `execCommand('insertText')` is
  deprecated and remains the only call that does neither. Verified in a real
  browser: Chinese in, English out, and `Ctrl+Z` returns the original exactly.

  Password, email, URL and the other value-shaped input types are refused
  outright — a password is not to be read, and an email has nothing to translate
  and comes back mangled. So are read-only and disabled fields. The focused
  element inside an open shadow root is found, since a comment box inside a web
  component reports the host as focused and would otherwise never be seen. And a
  field the writer has clicked out of during the round trip is left alone.

- **The language-pack note says to keep the popup open.** A Chrome extension
  popup closes the moment it loses focus, and the download is driven from that
  document. Measured across runs on the same machine, one pack took 16 s, 12 s
  and 390 s — so "a minute or two" is a hope, not a promise, and a reader who
  clicks away has no way to know they interrupted it. The harness reports the
  elapsed time now for the same reason: it is the only thing that tells a slow
  download from a stuck one.

### Fixed

- **The page's `<html lang>` was sent as the source language for text the page
  did not write.** Correct for everything read off the page, and wrong for the
  first thing that was not: typing Chinese into a box on an `en` page handed the
  engine "translate this English into English", so it returned the Chinese
  verbatim and the UI reported "it is already in that language". Found by the
  first end-to-end run of the feature above, which is exactly what that harness
  is for.

## [2.16.0] - 2026-08-06

### Added

- **Three settings for how a translation looks.** Show the original beside it
  or only the translation; mark it with a line down the side, nothing, a dashed
  underline, or a tinted background; and set it smaller, the same, or larger
  than the text it sits under. The line that reads as a quiet aside on one site
  reads as a blockquote on another, and a reader who trusts the output on a long
  article would rather not have the page doubled in length.

  All three follow the popup without a reload. Style and size are attributes on
  the document and pure CSS, so one write restyles a page of five hundred
  translations. Translation-only cannot be — a block's own text nodes cannot be
  hidden without hiding its children too — so the original moves into an
  `.oit-original` wrapper that CSS can act on, and switching back takes it away
  again. Nothing is re-translated either way, which is the whole point of
  changing a setting while looking at the page it applies to.

  The wrapper only exists in translation-only mode. Moving nodes on a live page
  is a thing to do as little of as possible: a script holding a reference to a
  paragraph's first child is not wrong to expect it to still be a child of that
  paragraph. Undo removes it, so a page that was translated once does not keep a
  span nobody asked for.

- **Hold a key, point at a paragraph, get that paragraph.** Between the two
  things this already did. Selecting a sentence is precise and costs a drag;
  translating the page is one press and rewrites everything. A reader working
  through an article in their second language usually wants neither — they want
  _this_ paragraph, the one that stopped them, without losing their place.

  Alt by default, with Ctrl, Shift and off in the popup. A held key rather than
  hover alone: a paragraph that translates itself because the mouse passed over
  it on the way to a link is a page that fights back, and a modifier is the one
  input that cannot be produced by accident while reading. The block under the
  pointer is outlined while the key is down, so the gesture answers "what will
  this do" before it does it — with an outline rather than a border, because
  outlines take no part in layout and cannot reflow the page under the cursor
  pointing at it.

  It shares `attach` and the appearance settings with a whole-page run, so a
  paragraph translated this way is indistinguishable from the same paragraph
  translated by a run — which is what lets undo and re-translate stay simple.
  Form fields, anything the reader is typing into, and our own insertions are
  never offered.

- **Thirty-nine target languages, up from eight.** Arabic, Bengali, Bulgarian,
  Croatian, Czech, Danish, Dutch, Finnish, Greek, Hebrew, Hindi, Hungarian,
  Indonesian, Italian, Kannada, Lithuanian, Marathi, Norwegian, Polish,
  Portuguese, Romanian, Russian, Slovak, Slovenian, Swedish, Tamil, Telugu,
  Thai, Turkish, Ukrainian and Vietnamese join the eight this shipped with.

  Every one was measured against a real Chrome rather than taken from
  documentation: `Translator.availability()` answered `available` or
  `downloadable` for all of them, in both directions. Twelve plausible
  candidates answered `unavailable` and are deliberately absent — Malay,
  Persian, Latvian, Estonian, Serbian, Catalan, Urdu, Swahili, Filipino,
  Gujarati and Malayalam among them — because offering a language the engine
  will refuse is worse than not offering it. A test now fails if the popup's
  list and the code table ever drift apart again.

## [2.15.1] - 2026-08-06

### Added

- **`pnpm e2e:stress` — hostile pages, in a real browser.** The happy-path
  harness walks a page that behaves. This one goes after the failure modes a
  live queue and two long-lived observers can have: an infinite feed appending
  460 paragraphs while the reader scrolls, an app that replaces `document.body`
  wholesale, the toolbar button pressed ten times in two seconds, nodes torn
  out from under the queue mid-run, five thousand blocks, and an exception list
  large enough to hit a storage quota. It found three defects on its first run,
  so it is kept rather than thrown away, and every check in it fails loudly.

  A second round covers the surfaces whole-page translation never touched: a
  selection panel opened on a page that is being watched, a selection made
  while the page queue is still draining, the Ollama engine pointed at a dead
  port, the bundled PDF viewer, and a real local model behind the same live
  queue. Twelve scenarios in all.

### Fixed

- **An app that swapped routes by replacing `<body>` stopped being
  translated.** The `MutationObserver` was attached to `document.body`, so a
  framework that replaces it left the observer watching a node no longer in the
  document. Measured: route A translated, route B untouched, and no amount of
  scrolling brought it back. It now watches `documentElement`, which survives
  everything short of a navigation — and mutations confined to `<head>`, which
  that brings into scope, are ignored, because a page loading a stylesheet has
  not grown anything to translate.

- **Pressing "translate this page" during an automatic pass produced no
  translation at all.** Automatic translation starts on load, so a press a
  moment later — out of habit, or because the first blocks had not landed —
  reached a toggle that read "running" as "stop" and aborted it. Measured on a
  real page at zero blocks translated: the control did the opposite of its
  label. A press during a pass nobody started now lets it finish; the badge's
  own Stop button is where stopping something you did not start belongs.
  Pressing a page that has finished still undoes it, as before.

- **A long list of excluded sites could stop every setting from saving.**
  `chrome.storage.sync` rejects any single item over 8,192 bytes, and settings
  are written as one object — so an over-long `autoTranslateExcept` took the
  target language and the engine down with it, silently. Measured: 200 hosts of
  ordinary length throws `Resource::kQuotaBytesPerItem quota exceeded`. The
  list is now capped at 6 KB on write, oldest dropped first, which still holds
  well over a hundred hostnames.

- **A selection panel made the page re-collect itself, repeatedly.** "Our own
  UI" was written out twice — once in `blocks.ts`, which knows about the
  selection panel and the floating icon, and once in `fullpage.ts`, which did
  not. So opening a panel, and every token streamed into one, read as the page
  growing new text and scheduled a full re-collection. There is one list now,
  exported from where the collector already needed it.

- **Blocks the page threw away were held for the life of the tab.** Deferred
  off-screen blocks live in a plain `Set`, because the `IntersectionObserver`
  has to be handed the same node to unobserve it — so on a feed that trims what
  scrolled past, detached nodes accumulated there. They are now swept on each
  rescan.

## [2.15.0] - 2026-08-06

### Added

- **The popup says whether the next translation will have to wait, and offers
  to get the wait over with.** Chrome downloads a translation model per
  language pair, once per browser profile, and it takes 30 seconds to two
  minutes. It is the longest wait anywhere in this product, and until now it
  was only ever met as an unexplained pause after a first press — which is
  indistinguishable from the extension being broken.

  The popup now reads the language of the page you are on, asks Chrome about
  that exact pair, and says one of four things: ready, downloading, not
  downloaded yet with a **Download it now** button, or a pair Chrome will not
  do at all and Ollama should. The pair matters — models are per pair, so
  telling a reader of Japanese pages that `en`→`zh-Hant` is ready would be
  worse than saying nothing.

  The download runs in the popup rather than through the background, because
  Chrome refuses to start one outside a user gesture: measured directly, an
  extension page throws `NotAllowedError: Requires a user gesture` while
  availability is `downloadable`, and the button click is the gesture. The
  service worker has no such gate, which is why a translation started from the
  toolbar can still download one by itself.

  Verified in a real browser: the popup opened over a live page named
  `en → zh-Hant` and reported it ready, switching the target to Japanese
  re-asked and reported `en → ja` not downloaded, and the button downloaded it
  and ended at ready.

### Fixed

- **The progress badge no longer sits at "0%" for a minute and a half.** The
  download monitor's granularity is not something a caller can rely on:
  measured at 479 progress events for `en`→`zh-Hant` and exactly two — 0 then 1
  — for `en`→`ko`, which took 81 seconds. A percentage that opens at zero and
  stays there reads as stuck, which is the impression the line exists to
  prevent. It now says "Downloading language pack…" until a number has actually
  moved.

- **The popup could report on the wrong engine.** The stored settings and the
  page's language arrive on separate promises, in either order, and the new
  language-pack line rendered from whichever landed last — so a user on Ollama
  could be shown Chrome's pack status, permanently if the page answered first.
  It now waits for the settings to reach the form.

## [2.14.0] - 2026-08-06

### Added

- **Translate automatically, off by default.** Three modes in the popup: off,
  pages in another language, or every page. Plus a checkbox that excludes the
  site you are on, permanently, and covers its subdomains — because the honest
  form of "translate everything" is one that can be told to stop here.

  The whole design is shaped by one asymmetry: a missed automatic translation
  costs the reader a keypress, and an unwanted one damages a page they could
  already read, on every load, until they find the setting. So the answer is no
  whenever the page does not say what language it is in. `<html lang>` decides
  it; a page that declares nothing is left alone rather than guessed at, since
  reading the text would mean telling English from Spanish from French and that
  guess ends with an English page translated into English forever. Bare `zh` is
  the one ambiguous tag worth resolving — both scripts are common under it — and
  that one is settled by the script detector this project already has. `zh-TW`
  and `zh-HK` count as Traditional without saying so, which is how the web
  actually writes it.

  Off by default. An extension that starts rewriting pages the moment it is
  installed has not been consented to yet, whatever the setting would have been
  worth afterwards.

  An automatic pass that finds nothing says nothing. A press that appears to do
  nothing looks broken, so it still answers "Nothing to translate on this page"
  — but the content script runs at `document_end`, and on an app that renders
  afterwards that badge would appear unbidden on every single navigation. The
  observers are attached either way, so "nothing yet" still becomes translated
  on its own.

  Verified in a real browser, four reloads with nothing pressed: a foreign page
  translated, an English page with English as the target neither translated nor
  even started, the same page on `always` started and correctly found nothing
  to do, and an excluded host untouched. The badge is what separates "decided
  not to" from "decided to and found nothing" — without it the last two look
  identical and the two modes are one mode with different labels.

## [2.13.0] - 2026-08-06

### Changed

- **A page now translates what you are reading, and keeps up — instead of
  translating all of it, once.** Pressing translate on the English Wikipedia
  article for artificial intelligence used to send all 308 blocks to the
  engine. A reader can see about five. The other 303 were their battery spent
  on text most of them will never scroll to, and the moment the page loaded
  anything new — a feed appending posts, a comment thread expanding, an SPA
  swapping a route — none of it was translated and the only remedy was to press
  the button again, once per screen.

  The queue is live now. It starts with the blocks within one screen of the
  viewport, an `IntersectionObserver` feeds it the rest as the reader arrives,
  and a `MutationObserver` feeds it whatever the page grows. Verified in a real
  browser on a 60-block page: 7 translated on the press, the top one yes and
  the bottom one no, 14 after scrolling to the bottom with nothing pressed, and
  a paragraph appended afterwards translated on its own.

  Two bugs found while building it, both of which only a live queue can have.
  A rescan landing mid-run re-collected every block still waiting its turn —
  they are untranslated, because they have not been reached yet — and the page
  got each of them twice. And a block the engine returns unchanged is left
  unmarked on purpose so a later run can retry it, which means every rescan
  collects it again, forever: one page of proper nouns, one infinite loop. Both
  are now closed by a claim set, and both have a test that fails without it.

  Stop and undo take the observers with them. A reader who presses Stop and
  goes on scrolling has said no, and a page that has just been put back must
  not translate itself again; three consecutive failures do the same, so a
  broken engine is not asked once per screen for the rest of the session.

- **`e2e/fullpage.mjs` covers the two properties jsdom cannot hold an opinion
  about.** jsdom lays nothing out, so every block sits at 0,0 and "near the
  viewport" is true of all of them, and it has no `IntersectionObserver` at
  all. The harness now builds a page longer than a screen and asserts what was
  translated, what was left alone, and what arrived on scrolling — and it waits
  for a named change rather than for the count to stop moving, because the
  waiting-for-quiet version passed and failed on identical code depending on
  whether a batch landed inside its window.

  It also takes `OPENREAD_PROFILE`. A throwaway profile is still the default,
  but it reports Chrome's language pack as `downloadable` and pays 30-130 s to
  register it on every run — which is how a once-per-profile setup cost was
  measured as a per-use one and sent a performance investigation down the wrong
  road for an afternoon. `Translator.create()` costs 82 ms on a cold browser
  and 1-3 ms warm, in the service worker and in a content script alike.

## [2.12.0] - 2026-08-06

### Added

- **`pnpm e2e:egress` — the privacy claim as a test a stranger can run.**
  "The default engine makes no network request at all" was, until now,
  something the author asserted and a reader could only verify by reading the
  source. For a tool whose entire pitch is that an unpublished draft stays on
  the laptop, and a repository with no stars to lend anyone else's judgement,
  that is the weakest possible form of the most important claim.

  The harness loads the built extension into a real Chrome, serves a fixture
  page from `127.0.0.1` so the page itself fetches nothing, attaches a CDP
  network listener to every target that will take one, and translates the whole
  page on the built-in engine. It fails if any request left the machine, if any
  went to Ollama — which would mean the built-in engine bowed out and the run
  says nothing about the default path — or if nothing was translated, since a
  run that translates nothing trivially sends nothing.

  Verified in both directions before shipping: on the built-in engine, four
  requests observed and every one of them the fixture; flipped to the Ollama
  engine, the same harness catches four `service_worker` requests to
  `/api/chat` and fails. A test that has never been seen to fail is not
  evidence of anything.

### Fixed

- **"Can't reach Ollama" — told to a user who does not have Ollama, has never
  heard of Ollama, and whose actual problem was their browser.** On Firefox, on
  Chrome 137 or older, or on a language pair Chrome has no pack for, the
  built-in engine raises `BuiltinUnavailableError` and the broker hands the
  request to Ollama instead of failing. That fallback is right — a user who has
  Ollama gets a translation rather than an apology. What was wrong is what
  happened when the second attempt also failed: the built-in reason was
  discarded and the panel showed Ollama's message alone, which named a server
  the reader had never chosen and said nothing about the browser that was the
  real cause.

  The broker now keeps the reason and `core/diagnostics.ts` composes both,
  first cause first: "This browser has no built-in translator (Chrome 138+
  does). OpenRead fell back to Ollama, which also failed: …". A user who picked
  Ollama deliberately still sees Ollama's message alone — there is no first
  cause to report, and inventing a fallback step that never happened would be
  its own kind of wrong.

  Same shape as the 2.11.0 fix: a lower layer's message reaching the panel
  unexamined. There the words were Chrome's; here they were the other engine's.

- The manifest `description` was inherited from `package.json`, where it is
  written for npm and runs to 188 characters. The Chrome Web Store rejects a
  package whose description exceeds 132, so the store upload failed outright.
  It is now set explicitly in `wxt.config.ts`, worded to match the listing's
  short description.

### Added

- `SECURITY.md`. For a tool whose whole claim is that text stays on the
  machine, having no route for reporting a breach of that claim was a gap in
  the claim itself. Reports go to a private advisory; most of the document is
  scope, naming the bugs worth hunting — content leaving the machine by any
  path other than the user's own Ollama URL, a page reaching the broker or the
  bundled viewer, and the `declarativeNetRequest` rule's `tabIds: [-1]` scoping
  failing in a way that lets a page's request match it.

- The README says where the default engine stops: Chrome 138+ on desktop, the
  eight target languages, that Chrome owns the language-pair matrix, and that
  the Firefox build is Ollama-only. All three were discoverable before this
  only by installing and finding out.

## [2.11.0] - 2026-08-06

### Fixed

- **"Other generic failures occurred." — Chrome's own words, reaching the
  panel, with a dead translator behind them.** A user selecting a paragraph
  mid-session got that message and nothing to do about it.

  Root cause, measured in a real Chrome against a cold profile:
  `Translator.create()` can resolve with an instance whose language pack is not
  installed yet. Nine pairs created at once — all nine creates resolved, then
  seven of the nine threw `UnknownError: Other generic failures occurred.` on
  their first `translate()` and never worked again. `availability` reported
  `available` immediately afterwards and a freshly created translator for the
  same pair worked on the spot, so the pack was fine; only the handle was not.

  Since 2.8.1 every request for a pair shares one cached instance, and the cache
  was only cleared when `create()` itself rejected. A create that resolved with
  a dead handle stayed cached for the life of the worker, so every later request
  for that pair — every block of a whole-page run, every selection — got the
  same message, with no way back short of restarting Chrome.

  A failed `translate()` now evicts the pair and retries once on a fresh
  instance. A failed `create()` is deliberately not retried: that is a download
  that did not finish, and a second attempt would spend another wait as long as
  the first with nothing on screen to explain it. If the retry fails too, the
  message says what to do instead of quoting the engine.

  Verified by fault injection against the shipped bundle in a real browser —
  `Translator.create` wrapped in the service worker to hand back one dead
  instance. On 2.10.6 the panel read `⚠️ Other generic failures occurred.`; on
  2.11.0 the same run produced the Japanese translation.

  Two earlier hypotheses were measured and discarded rather than shipped:
  concurrent `translate()` on one shared instance (four at once, all fine) and
  an instance going stale while idle (still fine after 180 s).

- **A Simplified Chinese page asked for Traditional Chinese came back
  Simplified.** `zh-CN` and `zh-Hant` both reduce to `zh`, so the
  same-language short-circuit treated the pair as "nothing to do" and returned
  the text with only the Taiwan vocabulary pass applied — which rewrites word
  choices, not characters. Measured on 2.10.6: `这个软件开发工具的用户介面` came
  back with 软件 and 用户 intact.

  Chrome has no zh-Hans → zh-Hant pack, but OpenCC does this conversion for the
  Ollama path already, so the built-in path now uses it: the same page returns
  `這個軟體開發工具的使用者介面`. Traditional in, Traditional out is unchanged,
  and no request is made of Chrome either way.

### Verified, not changed

- **An English page asked for English.** Already correct in 2.10.6 and
  re-measured here: nothing is inserted under any paragraph and the badge reads
  "Nothing to translate — this page is already in English". The same holds for
  every other language, because the check is on the engine handing the text back
  unchanged rather than on English specifically.

## [2.10.6] - 2026-08-06

### Fixed

- **The popup offered capture enrichment to people who had no local model.**
  Enrichment asks Ollama for a title, a summary and tags. The checkbox sat
  outside the block the popup hides when the engine is Chrome's built-in
  translator — the default — so a user with no Ollama at all could turn it on.
  Doing so produced "Enriching…" in the panel, a failed request nobody saw, and
  a plain capture with no word about why the summary was missing.

  The checkbox is now gated with the rest of the Ollama settings, and the
  capture path does not attempt enrichment unless Ollama is the engine, so the
  round trip and the misleading "Enriching…" are both gone.

  Everything else about capture is untouched and works on either engine: the
  note carries the original, the translation, the source URL, the time, the
  target language and `status: raw`, and goes to Obsidian through
  `obsidian://new` — or to the clipboard when it is too large for a URL.

## [2.10.5] - 2026-08-06

### Removed

- **The `OPEN_PDF_VIEWER` message, which nothing had ever sent.** It was
  declared in `messaging.ts`, handled in the background worker, and covered by
  two tests — so it read as a working feature, and its `PERMISSION_DENIED`
  reply looked like the answer to "what happens when file access is off".
  Nothing anywhere sent it, and nothing could: it was meant to come from a
  content script on a local PDF, and Chrome's own PDF viewer is a plugin
  document that content scripts do not run in. Tests that keep an unreachable
  path looking alive are worse than no tests, so the path and its tests are
  gone. The behaviour it was meant to explain is documented in the README
  instead, as of 2.7.9.

### Fixed

- **A disconnect could write into a panel it did not belong to.** Starting a
  second translation tears the first port down, and the first attempt's
  disconnect handler then reported "the background worker stopped" into
  whatever panel was on screen — which by then was the second translation's.
  It now checks the panel still contains the content div it was writing to.

- **`package.json` pointed `main` at `eslint.config.js`.** A resolver old
  enough to ignore `exports` — which is what `main` is for — would have loaded
  the lint configuration as the package entry point. It points at the CLI build
  now, the same file `exports` already resolved to.

### Notes

The service-worker disconnect from 2.10.1 was chased and **not** reproduced. A
fresh profile with no `en → zh-Hant` pack downloaded it in six seconds and
translated at seven, with a marker planted in worker memory still present
afterwards — so the worker never restarted. Two keepalive mechanisms were
measured before any of this: a marker survives 75 s with a port open and no
heartbeat at all, and adding a `getPlatformInfo` heartbeat changes nothing,
because an open port already extends the worker's life. A keepalive written on
that theory was reverted rather than shipped: code carrying a comment about a
problem it does not solve is worse than no code.

An earlier reading in this investigation was wrong and worth recording: a
service worker that is alive but not being inspected does not always appear in
CDP's target list, so "no service_worker target" is not evidence of
termination. Ground truth is a marker in worker memory.

## [2.10.4] - 2026-08-06

### Fixed

- **The 文 icon landed on top of the text when the selection spanned several
  lines.** It was placed against the selection's bounding box, and the bounding
  box of a multi-line selection is the union of its lines — its right edge is
  the _widest_ line and its bottom is the _last_ one, a corner that need not be
  near either. Measured on a six-line paragraph in a PDF:

  ```
  union      left 218  right 942  bottom 302
  last line  left 770  right 798  bottom 298
  icon       x 948  y 274   sitting over "A purely peer-to-pee"
  ```

  The icon now goes against the line the selection _ends_ on, which is where
  the drag finished and where a hand expects to find it. Same paragraph after
  the change: `x 804`, immediately after the last selected word.

  `getClientRects()` gives one rectangle per line fragment in document order,
  so the last of them is the end of the selection. Guarded, because not every
  host gives a Range the full interface and an icon slightly out of place beats
  a selection handler that throws.

- When there is no room after the text, the icon now goes _before_ the start of
  that line rather than under it. Under it is the next line, which is the thing
  2.8.3 set out to stop it doing.

## [2.10.3] - 2026-08-06

### Fixed

- **A drag that started in a PDF's margin selected nothing.** On a web page you
  can begin a little to the left of the first word and still get the line,
  because a paragraph's box runs the width of its container. In the viewer each
  span stops at the first glyph, so the margin belongs to nothing at all.

  Measured against a web page laid out to the same pitch:

  ```
                                          PDF          web
  starting 40px left of the first word    ""           the line
  wandering +-12px while dragging         the line     the line
  overshooting 60px past the end          the line     the line
  ```

  Each line's boxes are now widened to meet each other — half the gap either
  way — and the outermost ones reach up to 60 px into the margins. Padding
  grows the box while a matching negative margin leaves the glyphs where PDF.js
  put them, so nothing moves and character mapping inside a run is unaffected:
  the text still begins at the same x. Line boxes on the test page went from
  starting at x 76 to starting at x 22, and the margin drag now behaves exactly
  as it does on a web page.

  Re-checked afterwards: the vertical mapping from 2.10.2 is unchanged, five
  consecutive lines still select in sequence without clicking away, and the 文
  icon still lands against the end of the text rather than out in the widened
  box, because it is placed from the selection rather than from the span.

## [2.10.2] - 2026-08-06

### Fixed

- **Selecting text in a PDF took more precision than it should.** PDF.js sizes
  each line's span tightly around its glyphs, so the space between two lines
  belongs to neither of them: pressing there is pressing on the rendered page,
  and the drag selects nothing. A web page does not behave that way — a
  paragraph's box carries its line-height leading, so a press a few pixels high
  still lands on the nearest text.

  Measured on a five-line page: line boxes 15 px tall, 27 px apart, leaving
  12 px that nothing owned. Starting a drag 4 px above a line selected nothing
  at all.

  The bundled viewer now pads each line's hit box by 5 px a side and pulls the
  glyphs back with a matching negative margin, so the text does not move and
  the gap is no longer dead space. Pressing anywhere from 6 px above a line to
  8 px below its top now lands on that line; 8 px above still goes to the line
  before, which is the right answer.

  Verified that nothing shifted: glyph tops were 144, 171, 199, 226, 253 before
  the change and are 144, 171, 199, 226, 253 after it.

### Notes

This one was checked against a baseline before anything was changed, because
"the PDF viewer is fiddly" is as likely to be PDF.js as it is to be us. The
same viewer, the same document and seven kinds of drag — whole line, a phrase
mid-line, drifting six pixels while dragging, starting above the line, across
three lines, right to left, double-click — produced **byte-identical** results
with the extension loaded and with it unloaded. Nothing OpenRead does was
making selection harder. What it can do is ship a viewer that is easier to use
than the stock one, which is what this change is.

## [2.10.1] - 2026-08-06

### Fixed

- **The selection panel could wait for ever.** A Manifest V3 worker is
  terminated when it goes idle, and a language-pack download is minutes of
  exactly that: no port traffic while Chrome fetches, so the worker is
  reclaimed mid-request and the port closes without a `done`. Whole-page
  translation has always handled that disconnect; the panel did not, and sat on
  _Translating…_ with nothing to end it. Found on a real PDF whose target pack
  had never been fetched — the panel was still waiting long after the worker
  had gone.

  The panel now says the worker stopped, and keeps whatever had already
  streamed in rather than throwing it away.

- **The waiting message named an Ollama model to people not using Ollama.**
  With the default engine — Chrome's built-in translator, nothing installed —
  a slow first request said _"still waiting on qwen3:latest"_, a model the
  reader had never heard of and could not have installed. It now describes the
  language pack, which is what the built-in engine is actually waiting for, and
  names a model only when Ollama is the engine.

  Same PDF, same cold pack, after the change:

  ```
     0s  Translating…
     4s  Downloading the language pack — 22%. This happens once per language.
     6s  Downloading the language pack — 100%. This happens once per language.
     7s  第一行：本機伺服器只回應它被告知要信任的請求。
  ```

### Notes

Two things checked along the way and found healthy, against an earlier guess of
mine that they were the problem: language detection works fine in the service
worker — on a fresh profile `LanguageDetector.create()` took 7 s to fetch its
model and then reported `en` at 0.9988 confidence — and whole-page translation
on a page with no `<html lang>` at all completes normally. The PDF viewer's
empty `lang` is not what was breaking this.

## [2.10.0] - 2026-08-06

### Added

- **Whole-page translation reaches inside web components.** A component keeps
  its text in a shadow root and `querySelectorAll` does not go in, so a page
  built out of them was reported translated while most of it was untouched.
  Measured before: two paragraphs inside an open shadow root, and the badge
  read `Done — 1 translated` — the one paragraph in the light DOM.

  Each root is now collected on its own terms: its own `main`, its own
  navigation and citation skips, its own leaf-most-wins. That is not a
  shortcut, it is the right answer — `closest()` does not cross a shadow
  boundary either, and a component's `<nav>` is its navigation rather than the
  page's.

  The toggle had to learn the same trick, or a translation inserted inside a
  component would be one it could never find to remove.

  Verified on a page with a light-DOM paragraph, a component containing a
  `<nav>` and two paragraphs, and a second component nested inside the first:

  ```
  after translating   light 1   shadow 2   nested 1   nav 0   Done — 4 translated
  after toggling off  light 0   shadow 0   nested 0   nav 0
  ```

  Closed shadow roots stay out of reach, which is what closed means.

### Changed

- The "does this block already carry its translation" check is a direct-child
  scan rather than a `:scope >` selector. Same rule, but `:scope` inside a
  shadow root is not something to depend on — jsdom answers it wrong, and a
  selector that quietly means something else in one tree is a bad foundation
  for a skip rule.

## [2.9.0] - 2026-08-06

### Added

- **Copy, beside Save to Obsidian.** The most common thing to do with a
  translation is put it somewhere, and until now the only somewhere was an
  Obsidian vault. It also gives the capture path an honest fallback: handing a
  URL to the OS protocol handler produces no completion signal, so if Obsidian
  is not installed the panel says "Sent" and nothing happens — and now there is
  a second button right there that does work.

  It goes through the same clipboard helper the oversized-capture path already
  used, which tries `navigator.clipboard.writeText` and falls back to
  `execCommand`. Written straight against `writeText` first, it was measured
  failing inside a real click handler on a plain `http://127.0.0.1` page; with
  the fallback the clipboard comes back holding exactly what the panel shows.

### Fixed

- **The panel's × scrolled away with the text.** The close button is positioned
  against the panel, and the panel was the scrolling element, so reading to the
  end of a long translation carried it off the top — measured at `top: -51`.
  The text is now the part that scrolls, so the × above it and the buttons
  below it stay where the user left them. Same panel after the change, scrolled
  to the end: close at `top: 138`, Copy at 649, Save at 651, all three
  hit-testable.

## [2.8.5] - 2026-08-06

### Fixed

- **A whole-page run against a server that is not there marked every block.**
  With Ollama stopped, all twenty-eight blocks failed the same way and all
  twenty-eight got a `⚠️ translation failed` line — one problem, stated
  twenty-eight times, and a page the reader then had to clear before it read
  normally again.

  Three consecutive failures now end the run, and the markers those three left
  are taken away with it. One block failing on its own is bad luck, which is
  why the counter resets on anything that works; three in a row is a setup that
  is not going to start working on block four.

  Same page, Ollama pointed at a port nothing is listening on:

  ```
  badge      Gave up after 3 failures — Can't reach Ollama at http://localhost:18999. Is the server running?
  seconds    4
  inserted 0   warnings 0   markers 0
  ```

  Whatever was translated before the failures started stays on the page, and a
  run that ends this way is not reported as the user having stopped it.

## [2.8.4] - 2026-08-06

### Fixed

- **The popup only saved when you pressed Save, and "Translate this page" sits
  above the language selector.** So the obvious sequence — open the popup, pick
  a different target language, press the big button next to it — translated
  into the language you had just moved away from. Verified in the real popup
  before the change: firing `change` on the selector left
  `chrome.storage.sync` empty.

  Every control now writes through as it changes, and "Translate this page"
  persists before it hands off, so the page is translated with what the popup
  is showing rather than with what was last saved. Text fields write on
  `change` rather than `input`, so a half-typed server URL is not probed and
  stored on every keystroke.

  The Save button stays, and is still the only thing that says "Saved ✓": a
  status line flashing on every dropdown movement is noise, and the dropdown
  showing the new value is already the confirmation.

  Same popup after the change: picking Japanese stores it immediately, and
  switching the engine stores that too, with the status line left blank.

## [2.8.3] - 2026-08-06

### Fixed

- **Selecting text in a PDF fought back.** Reported from use: web pages select
  cleanly, PDFs feel sticky. They were — every other line could not be selected
  at all.

  The 文 icon is a 28-pixel button placed six pixels under the selection, and
  in a PDF that is exactly where the next line is. Its `mousedown` handler
  calls `preventDefault()`, so a drag starting there never begins a selection;
  the press translates the previous line instead. Measured on a five-line PDF —
  line boxes at y 92, 122, 152 with a height of 20, leaving ten pixels between
  lines for a button that needs thirty-four:

  ```
  line one   -> "Line one: a local server answe"   icon at y 119 (covers 119-147)
  line two   -> ""                                 <- nothing selected
  line three -> "Line three: the original text "
  ```

  Web pages hide this behind paragraph margins rather than avoiding it; a dense
  list or a table does the same thing there.

  The icon now sits **beside** the end of the selection instead of under it,
  falling back to the old placement only when the selection runs to the window
  edge and there is no room. Same PDF after the change: **5/5 consecutive lines
  selected**, no need to click elsewhere between them.

## [2.8.2] - 2026-08-06

### Fixed

- **Asking for a language the page is already in printed the whole article
  twice.** Reported from use, with English selected as the target on the
  English Wikipedia article: every paragraph gained a copy of itself
  underneath, indented and quoted like a translation.

  Both engines answer "translate this into the language it is already in" by
  handing the text straight back. That is the honest answer in the selection
  panel — the user highlighted something and gets told, in effect, that it
  already reads that way. Whole-page translation took the same reply and
  inserted it, so 28 blocks came back byte-identical and the page doubled in
  length.

  A block whose translation is exactly its source now has nothing inserted for
  it, whatever the language pair: a block of proper nouns comes back unchanged
  from a real translation too, and a duplicate of it is no more use. When that
  accounts for the entire page the badge says so —
  _Nothing to translate — this page is already in English_ — rather than
  reporting `Done — 0 translated`, which is true and explains nothing.

  Those blocks are deliberately left unmarked, so a later run tries them again.
  Marking them would save the second pass, but the marker means "a translation
  is appended below this block", and 2.7.7 exists precisely because a marker
  without one is treated as stale. Two meanings for one attribute is how that
  bug comes back.

  Verified on the same page: English target, `inserted 0`, no paragraph
  touched; then switched to Traditional Chinese, one press,
  `Done — 8 translated`.

## [2.8.1] - 2026-08-06

### Fixed

- **Translating into a language whose pack was not installed crawled for
  minutes.** Reported from use: switch the target language, press translate,
  and the badge sits on `Translating 0/28`, advancing two blocks every thirty
  seconds.

  Every block called `Translator.create()` and destroyed the result afterwards.
  That costs nothing once the pack is installed — 82 ms a block against 4 ms
  for a reused instance — and is ruinous while it is not: whole-page
  translation runs two requests at a time, so twenty-eight blocks meant
  twenty-eight separate creates all waiting on the same download, and none of
  them ever handed the finished pack to the next. Measured live on the reported
  page, minutes into the run:

  ```
  availability   en->ja "downloadable"   en->zh-Hant "available"
  en->ja timing  create 145687ms   translate 77ms   destroy 0ms
  ```

  One create took two and a half minutes; the translation it was for took 77
  milliseconds, and `availability` never left `downloadable`.

  There is now one translator per language pair, shared by every request for
  it. Twelve blocks on a real page: **one** `Translator.create` call, where it
  used to be twelve. A cold German pack now downloads once and the whole page
  finishes in 4 s, with the badge reporting `Downloading language pack
29% … 100%` while it happens.

  Abort still takes effect immediately — the shared create is deliberately left
  running when a request gives up on it, since a user pressing Stop during a
  language-pack download should not also throw the download away for whoever
  asks next.

### Notes

The download badge itself turned out to be fine: driven against a cold French
pack it reported `22% … 100%` within two seconds. It was invisible on the
reported run because each block was waiting on its own download rather than on
the one the badge was watching.

## [2.8.0] - 2026-08-06

### Fixed

- **Switching target language erased the page instead of retranslating it.**
  Translate a page, pick a different language in the popup, press translate —
  and every translation vanished. A second press then translated into the new
  language, so changing language cost two presses and the first one looked like
  the feature breaking.

  The toggle asked one question, "is there a translation on this page", and the
  answer was yes, so it undid. It had no way to notice that the translation
  sitting there was in the language the user had just moved away from.

  Since 2.7.6 every inserted node carries its target as a BCP-47 `lang`, so the
  page already records what it was translated _into_. The toggle now reads it:
  a translation in the current target still means undo, and a translation in
  any other language means the press was a request for this one. Measured end
  to end — `zh-Hant` × 3 nodes, switch to Japanese, one press,
  `["ja"]` × 3 nodes reading `ローカルの翻訳ツールは…`.

  Undo is untouched where nothing changed, and a target the BCP-47 table does
  not know still undoes rather than guessing: "unknown" must not be read as
  "wrong" and quietly retranslate a page the user asked to clear.

  Reported from use, which is where the previous nine rounds of automated
  auditing had not looked: every one of them pressed the toggle twice with the
  same settings and saw exactly the behaviour it expected.

## [2.7.9] - 2026-08-06

### Fixed

- **The README promised `file://` PDFs without mentioning the switch they
  need.** Chrome withholds `file://` from every extension until the user turns
  on **Allow access to file URLs**, which is off on a fresh install.
  `routeToViewer` checks `chrome.extension.isAllowedFileSchemeAccess()` and
  returns silently when it is false, so a local PDF opens in Chrome's own
  viewer with no OpenRead in it and nothing anywhere saying why. Two lines of
  the README sold that as a headline feature.

  Both places now name the prerequisite and say what it looks like when it is
  missing.

### Notes

Found while auditing the PDF path. The state itself could not be reproduced in
the harness: an extension loaded through CDP's `Extensions.loadUnpacked` is
granted file access (`isAllowedFileSchemeAccess` returned `true`) and does not
survive a restart, so patching the profile's preferences between launches has
nothing to patch. What is verified is the other half — with access granted, a
`file://` PDF is redirected into the bundled viewer and renders. The claim
being corrected rests on Chrome's documented default rather than on a
measurement here, and is written that way.

Also in the same pass, and left alone deliberately: `OPEN_PDF_VIEWER` /
`PERMISSION_DENIED` exist in `messaging.ts` and are handled in the background
worker, and nothing anywhere sends the message. It reads like an abandoned
attempt to surface exactly this denial. Wiring it up would be a feature and
deleting it would be a refactor; this pass is neither.

Whole-page translation over iframes was checked and behaves as designed: three
iframes, none of them translated, because `content.ts` restricts the whole-page
pass to the top frame so an ad iframe cannot spend the user's GPU on someone
else's banner. Selection translation inside an iframe still works.

## [2.7.8] - 2026-08-05

### Fixed

- **The translation panel could open off the bottom of the window, taking
  "Save to Obsidian" with it.** Where the panel goes is decided before it has a
  height: the up-or-down choice tests a fixed 300 px of space below the
  selection, which has nothing to do with how tall that particular panel turns
  out to be. A long selection therefore opened downward into a box that ran
  past the bottom of the viewport — and the panel is `position: fixed`, so no
  amount of scrolling brings it back.

  Measured on a 975-character selection in a 703 px viewport:

  ```
  panel 442..1005 of 703   save 961..990  reachable=false
  ```

  Three hundred pixels below the fold, and `elementFromPoint` on the button
  returns nothing. The same arithmetic ran the other way for a selection near
  the bottom of the screen, putting the panel's top at −189.

  The panel is now re-fitted whenever it grows, which is the part that matters:
  fitting it once at mount proves nothing, because it is mounted empty and
  forty pixels tall — the translation arrives afterwards, and so does the
  capture bar. Same case after the fix: `panel 132..695 of 703`, save button
  reachable.

- **The clipboard fallback for oversized captures had never actually run.** It
  is guarded by `URI_LIMIT`, and reaching that limit takes a note of several
  thousand characters — which is exactly the case where the button to trigger
  it was off-screen. With the panel fixed, a 1,246-character capture now
  produces 2,712 characters on the clipboard, frontmatter and all, with both
  the first and last sentence of the original intact and no oversized
  `obsidian://` URL handed to the OS to truncate.

### Notes

Found while auditing the capture path. Also exercised and found healthy in the
same pass: a server that sends its response headers and then nothing at all —
the panel gives up after 62 s and says _"Ollama sent nothing for 60s while
streaming the translation. The server may be wedged, or still loading the model
— try again, or run `ollama ps` to see what it is doing."_ — and a small capture
still going out through `obsidian://` without touching the clipboard.

One defect is reported rather than fixed: the panel's × scrolls out of view
with the content once a translation is long enough to make the panel scroll
(measured at `top: -51` after scrolling to the bottom). Escape and clicking
outside both still dismiss it, and moving the control out of the scrolling box
is a layout change rather than a fix.

## [2.7.7] - 2026-08-05

### Fixed

- **A single-page app said "Nothing to translate on this page" over a page of
  untranslated text.** React and Vue reconcile a route change by reusing the
  existing element and writing new text into it. `data-oit-translated` lives on
  that element, and writing to `textContent` destroys the appended translation
  while leaving the marker behind — so the marker outlived the thing it was
  claiming, and every reused block on the new route read as already done.

  Measured on a two-paragraph SPA driven through `history.pushState`:

  ```
  after route change: marked=true, translation=null   (both blocks)
  badge:              Nothing to translate on this page
  ```

  A route that replaced its nodes outright was never affected, which is why
  this survived: the naive router works and the popular ones do not.

  The marker is now checked against the evidence for it. A block carrying the
  marker but no `.oit-bilingual` child of its own has had its text replaced
  underneath, so the stale claim is dropped and the block goes back into the
  queue. Same page after the fix: `Done — 2 translated`, both paragraphs
  bilingual.

### Notes

Found by driving `pushState` in a real browser rather than reloading between
assertions. Also exercised and found healthy in the same pass: a server that
accepts the request, streams two chunks and then destroys the socket. The panel
shows `⚠️ Can't reach Ollama at http://…. Is the server running?` rather than
presenting `這是被截斷的半句話` as a finished translation, and offers no capture
button for the half that arrived.

One harness note, since it cost a run: port 8799 was already held by an
unrelated app on the test machine, and Windows let a second `0.0.0.0` bind
succeed alongside it without `EADDRINUSE`, so Chrome quietly loaded someone
else's page and the extension dutifully translated it. Harness servers now bind
`127.0.0.1` explicitly.

## [2.7.6] - 2026-08-05

### Fixed

- **The whole-page keyboard shortcut was never bound.** `Ctrl+Shift+G` is
  Chrome's own "find previous". Chrome does not reject a manifest that asks for
  a key it has already claimed — it installs the extension, registers the
  command, and leaves the binding empty. So from 2.7.0 to 2.7.5 the README
  documented a shortcut that did nothing, and nothing in the repository could
  tell: the manifest said `Ctrl+Shift+G` and the code behind the command was
  correct.

  Found by asking a real browser instead of the manifest.
  `chrome.commands.getAll()` returned `shortcut: "Ctrl+Shift+Y"` for
  `translate-selection` and `shortcut: ""` for `translate-page`. Probed four
  candidates in a patched copy of the build: `Ctrl+Shift+G` came back empty,
  `Ctrl+Shift+U`, `Ctrl+Shift+L` and `Ctrl+Shift+K` each came back assigned.

  Now `Ctrl+Shift+L` / `Command+Shift+L`, and `tests/commands.test.ts` fails if
  a suggested key walks back into a combination already known to be taken.

- **Translations were marked with a language tag that is not a language tag.**
  Every inserted whole-page translation carried `lang="Traditional Chinese"` —
  the dropdown's display name, put straight onto the attribute.
  `Intl.getCanonicalLocales('Traditional Chinese')` throws a RangeError on it.

  This is the attribute that tells a screen reader to switch to a Chinese
  voice; an unparseable value means it keeps the page's own `lang` and reads
  Chinese aloud in English. Now mapped through the existing `toBcp47` table
  (`zh-Hant`), and left off entirely when a target maps to nothing, because no
  tag inherits while a wrong one asserts.

  The selection panel had the matching hole: it is an `aria-live` region
  precisely so the translation is announced, and it announced it with no
  language marked at all. It is now marked while the translated text is on
  screen and unmarked again for the English status lines, so
  `Ollama 404: model not found` is not read in a Chinese voice either.

### Notes

Both found in an accessibility pass. Also exercised and found healthy in the
same pass: the floating icon is a `button` named _Translate selection_ and is
one Tab stop away; Enter on it translates and moves focus into the panel; the
panel is a `dialog` named _Translation_ whose Close and Save-to-Obsidian
controls are both reachable by Tab and both correctly named; the progress badge
is `role="status"`, `aria-live="polite"`, with a button named _Stop_.

Earlier rounds of the same audit found nothing to fix: three tabs translating
at once finished 8/8 blocks each with no failures; the service worker was left
to be reclaimed on its own idle timer and the first request after the cold wake
came back in 6 s with the `declarativeNetRequest` session rule still installed;
twenty hostile Ollama URLs — IDN, IPv6, credentials, a 300-character host —
produced no rejection from `updateSessionRules`, with internationalised hosts
punycoded and `*` percent-encoded rather than becoming a wildcard.

## [2.7.5] - 2026-08-05

### Fixed

- **"Translate this page" did nothing in the PDF viewer.** The context menu
  offers the action on every page, the bundled viewer included, and there was
  no receiver there — `pdf-viewer.ts` mounted only the selection translator.
  A click, then silence.

  It stays unavailable, and now says so. A PDF text layer is absolutely
  positioned spans, one per line, laid over the rendered page; a translation
  appended under each would land on top of the next line and destroy the
  document. Selection translate is the right interaction for a PDF and works
  there — verified end to end on the Bitcoin whitepaper, which came back
  `比特幣：點對點電子現金系統`. Of the three options — do nothing, hide the
  menu item, refuse out loud — the first was the one shipped and the worst.

- **Whole-page translation threw away the reason it failed.** The broker
  produces something a user can act on (`Can't reach Ollama at http://…. Is
the server running?`) and the selection panel shows it. This path discarded
  it and printed `⚠️ translation failed` once per block: on a real article,
  twenty-eight identical lines, none of them saying what to do.

  The first real reason is now carried into the run summary —
  _Done — 0 translated, 2 failed — Can't reach Ollama at http://127.0.0.1:1.
  Is the server running?_ — which is the one place worth reading it.

### Notes

Found by auditing rather than by waiting for a report. Also exercised and
found healthy in the same pass: selection translate through a real mouse drag,
the capture button, Escape dismissal, PDF routing and PDF selection translate,
the Ollama engine end to end, and a Simplified-Chinese target confirming the
Taiwan vocabulary pass correctly does **not** run for it
(`此域用于文档示例，无需许可。`).

## [2.7.4] - 2026-08-05

### Fixed

- **Switching target language looked like the extension breaking.** It was a
  silent 95-second wait.

  Chrome downloads a language pack per _pair_, on first use. English→Traditional
  Chinese having been fetched buys nothing for English→Japanese: that is a
  fresh download, and every one of the seven non-English targets this extension
  offers reports `downloadable` on a clean profile. Meanwhile the badge sat at
  `Translating 0/2` and the selection panel said `Translating…`, so the only
  reasonable conclusion was that it had stopped working.

  The plumbing for this existed and was never connected — `translateBuiltin`
  has taken an `onDownloadProgress` callback since 2.7.0 and the broker never
  passed one. It does now, over a new `downloading` message on the stream port.
  The whole-page badge reads _Downloading language pack 42%_; the selection
  panel says the same and adds that it happens once per language.

  Measured on a clean profile with the target set to Japanese: progress
  appeared at **7 s**, the page finished at **95 s**, and the translation was
  correct. The wait is Chrome's and cannot be removed. Being told about it is
  the whole fix.

## [2.7.3] - 2026-08-05

### Added

- **Right-click to translate.** Two context-menu items: _Translate selection
  with OpenRead_ when text is selected, _Translate this page with OpenRead_
  otherwise.

  Whole-page translation shipped in 2.4.0 reachable only from the toolbar
  popup and `Ctrl+Shift+G`. Both work, and neither is where anyone looks. A
  user with the extension installed opened the context menu, found Chrome's
  own _翻譯成中文（繁體）_ item and not this one, and asked where the feature
  had gone — which answers the question of whether a popup button counts as
  discoverable.

  The menu is rebuilt rather than appended to on every worker start, because
  an MV3 worker restarts whenever it likes and `contextMenus.create` on an id
  that already exists is an error.

  `contextMenus` is the fourth permission this extension asks for, and it
  earns its place the way `declarativeNetRequest` did in 2.5.0: one concrete
  job, visible to the user, with the alternative being a feature people cannot
  find.

## [2.7.2] - 2026-08-05

### Fixed

- **A stylesheet was being sent to the translator.** One Wikipedia reference
  item carried a `<style>` child, and `textContent` concatenates those: 2,158
  characters of which **2,100 were CSS**. The model translated it — rendering
  `no-repeat` as `無重複` and `center` as `中心` inside a rule set — and the
  result landed on the page as a wall of mangled stylesheet.

  `SKIP_WITHIN` could never have caught it. That check uses `closest()`, which
  looks at ancestors, and the stylesheet was a _child_. Block text is now read
  through `visibleText()`, which walks the tree and skips descendants that are
  not prose. `innerText` would also have worked, but it forces layout and jsdom
  does not implement it, which would have put this rule beyond the reach of
  every test.

  It also skips this extension's own insertions, so a second run over a page
  reads the original text rather than the original plus the first run's output.

- **Reference lists are no longer translated.** A bibliography is a lookup key,
  not prose. Translated, it stops working: the same page turned the publisher
  `Ollama` into `奧拉瑪` and the article title `"Blog"` into `"博客"`, leaving a
  reader unable to find either. Sixteen of that article's forty-eight blocks
  were references — skipping them is also a third off the work.

  `cite` is standard HTML; the MediaWiki classes are added because a reference
  list is where most readers will meet one. Citations are excluded both by
  ancestor and inside `visibleText`, so a paragraph that merely _cites_
  something has its prose translated and the work's title left findable, while
  a paragraph that is nothing but a citation drops out on its own.

  Same page, verified live against the loaded extension: 44 blocks to **28**,
  no CSS in the output, no translated citations, no mainland vocabulary.

## [2.7.1] - 2026-08-05

### Fixed

- **A claim published in 2.7.0 was wrong, and this retracts it.** That release
  said Chrome's built-in translator "produced the Taiwan conventions the OpenCC
  `s2twp` layer exists to produce, arrived at natively". It does not. That
  conclusion came from three sentences that happened to come out right.

  Watching the extension translate a real page showed it immediately. Counted
  over that page — 44 blocks, 4,734 characters — Chrome's `zh-Hant` wrote
  本地 twelve times, 運行 ten, 代碼 four, 用戶 three, 項目 twice and 配置 once:
  **thirty-two words a Taiwanese reader notices at a glance**. Traditional
  characters, mainland vocabulary.

  OpenCC cannot correct it. `s2twp` keys its phrase tables on _Simplified_
  forms, so already-Traditional text never matches, and the
  Traditional→Simplified→Traditional round trip that would make it match is
  lossy: 髮 and 發 both collapse to 发 on the way down.

  So the built-in path gets its own pass — `src/core/tw-vocab.ts`, a small
  explicit table of software terms where the conventions genuinely differ, with
  the exceptions written down rather than discovered later (`本地化` is correct
  Taiwan usage; `用戶端` is the ordinary Taiwan word for a client). Same page
  after it: **32 → 0**, the only remaining match being the `本地` inside
  `本地化` that the exception exists to protect.

  Re-reading the _corrected_ page then turned up four more: 操作系統, 文檔,
  穩定釋放, and 本機機器 — a stutter this very table introduced by rewriting
  本地機器 one word at a time. All four are now covered, and a wider scan of
  thirty candidate terms over the same page comes back empty.

  The built-in engine also stopped streaming. Correcting vocabulary is a
  phrase-level rewrite that a chunk boundary can split down the middle — the
  same hazard OpenCC has on the Ollama path, where it is handled by holding the
  ambiguous tail back. Here there is no first paint worth protecting: the whole
  article now finishes in **2 s** once the language pack is resident, so the
  result is simply buffered.

  Worth stating plainly, because this project keeps catching this exact error
  in itself and this time made it: a claim drawn from three cherry-picked
  sentences is not a measurement, and it went into a README, a changelog and a
  shipped release before a real page contradicted it.

## [2.7.0] - 2026-08-05

### Changed

- **Chrome's built-in translator is now the default; Ollama is the advanced
  option.** Installing the extension is the whole setup. No server, no
  5.2 GB model.

  This is the answer to the question the project kept failing: it was genuinely
  useful and nobody could reasonably install it. Every previous release chipped
  at the setup cost — eight steps to two, an environment variable removed, a
  connection check that explained failures — while leaving the largest item
  untouched, because it looked like a law of nature. "Local-first means a local
  model" turned out to be false. Chrome ships one.

  Measured, all on the same machine and the same Wikipedia article (44 blocks):

  |               | Chrome built-in                         | Ollama + qwen3  |
  | ------------- | --------------------------------------- | --------------- |
  | user installs | nothing                                 | server + 5.2 GB |
  | first use     | 131 s, once, automatic                  | manual          |
  | full article  | **16 s** (14 s of it the one-time pack) | 54 s            |
  | steady state  | **~2 s**                                | 54 s            |
  | failed blocks | 0 / 44                                  | 0 / 44          |

  Verified with Ollama fully stopped — `curl` refused on 11434 in the same run
  — so the translations came from Chrome and nothing else.

  Quality is not the trade it looks like. On the sentences the Ollama path was
  benchmarked on it produced `使用者介面`, `資料庫連線字串` and
  `本地電腦上運行大型語言模型`: the Taiwan conventions that the OpenCC `s2twp`
  layer exists to produce, arrived at natively because `zh-Hant` is a
  first-class target rather than a post-processing step.

  Ollama stays, and stays worth choosing: it reads the surrounding page for
  context, lets you pick the model, and is what capture enrichment runs on.
  It is a language model; the other is a translator.

  The engine lives in the background worker beside the Ollama broker, so the
  port protocol is unchanged and neither the selection UI nor whole-page
  translation knows which one answered. A request the built-in engine cannot
  serve falls through to Ollama; a genuine error from it does not, because that
  would hide a bug behind a second engine.

- **The reliability layer is not load-bearing on the default path, and the
  README now says so.** A dedicated translation model does not emit a preamble,
  think out loud, or echo its input. That layer is why the Ollama path is
  trustworthy and it is why this project exists, but claiming it for an engine
  that never needed it would be the same kind of unearned credit the eval
  harness was caught taking in 2.2.7.

### Fixed

- **Six blocks of a real article failed before this shipped.** The first
  Ollama-free run translated 38 of 44. The cause was a 0.5 confidence floor on
  language detection: short fragments — captions, citations, proper nouns —
  score below it, and "Ollama running Llama 3 in Linux" came back `en` at
  **0.248**. The page had declared `lang="en"` all along.

  Requests now carry the page's own `<html lang>`, and detection is a fallback
  for pages that declare nothing, with a floor low enough to be useful. Same
  page, Ollama still down: **44 of 44, and 28 s to 16 s** now that it is not
  running a detector per block.

## [2.6.3] - 2026-08-05

### Changed

- **Published to npm.** `npx openread "…"` now works with no install step
  at all, and `npx -y openread mcp` is a one-line MCP server entry for any
  client. Until this release the only route was
  `npm install -g github:0Smallcat0/OpenRead`, which clones and builds from
  source and takes a couple of minutes — fine for a contributor, far too
  much for someone who wants to translate one paragraph without sending it to
  a cloud.

  The release workflow has published on tag since 2.6.1; what was missing was
  the `NPM_TOKEN` secret, which only the maintainer can create. Publishing
  carries `--provenance`, so the tarball on npm can be traced back to the tag
  and the workflow run that built it.

  The README now documents `npx openread` because it is finally true. It said
  so once before, in 2.6.0, when the package did not exist — that line was
  removed in 2.6.1 rather than left to be discovered by whoever tried it.

## [2.6.2] - 2026-08-04

### Fixed

- **A failure on every real page, and a cold start that multiplied it.**
  Measured on the Wikipedia article for Ollama, before: 237 s and **9 of 45
  blocks failed** on a cold model, 55 s and 2 of 45 once warm. After: **54 s,
  0 of 44 failed**, reproduced twice.

  Three causes, each found by running the thing rather than reasoning about it.

  _A URL is not prose._ The block that failed on every single run was the
  infobox cell reading `github.com/ollama/ollama`. It has letters, so
  `hasTranslatableText` passed it; it has nothing to translate, so the model
  returned an empty generation and the page printed a failure the reader could
  do nothing about. Addresses — URLs, bare hosts, emails — are now
  removed before the length check, so a cell that is only an address is
  skipped while a sentence that merely mentions one is kept. The host pattern
  requires a two-letter word after the dot, which is what keeps it away from
  `version 2.5.0` and `e.g.`.

  _No retry._ The selection path has always retried an empty generation with a
  raised temperature. Whole-page translation never did, so one empty sample
  printed a permanent failure. It now retries once, through the same broker
  path, which is a different sample rather than the same request hopefully
  going better.

  _A cold burst._ The first request to a cold Ollama waits for the model to
  load into VRAM — about 5 s here — and a second request racing it does
  not arrive sooner, it only lengthens the queue while the same load happens.
  That burst is where the cold-run failures clustered. The first block now runs
  alone and the queue opens to full concurrency once it returns, against a warm
  server. This costs nothing when the model is already resident.

  The ramp-up shipped broken on the first attempt — `await worker()` drains
  the whole queue, so the run went fully sequential — and the concurrency
  test caught it before it left the branch.

### Known limits

- Whole-page translation on a long article is a background job, not an
  interactive one. The Wikipedia article for large language models is 157
  blocks and takes over five minutes end to end. Blocks are translated in
  document order and first paint is 2–4 s, so a reader working down from
  the top is never waiting on the queue — but the badge will be counting
  for a while.

## [2.6.1] - 2026-08-03

### Added

- **A CLI and an MCP server.** `npx openread "…"` translates from a shell;
  `openread mcp` exposes the pipeline to any MCP client.

  Everything valuable this project has built — the artifact filters, the
  streaming assembler, the Taiwan-convention conversion, the prompt chosen by
  benchmark — was reachable only by a person clicking inside Chrome. A
  script could not use it. Neither could an agent. That is a strange place to
  keep a text-in / text-out function.

  It is the same pipeline, not a reimplementation: `src/node/translate.ts`
  calls the identical `translateStream` the extension calls, with the same
  request, the same `think: false`, the same `StreamAssembler` and the same
  OpenCC transform. The core was written framework-free so this file could be
  twenty lines, and it is. A test pins the CLI's defaults against
  `DEFAULT_SETTINGS`, because the same text coming back differently depending
  on how you asked is a bug nothing else in the project would notice.

  The MCP server is hand-rolled rather than built on the official SDK. A stdio
  tool server needs five methods, and a project whose argument is that its
  claims are checkable is better served by a handshake it tests than by a
  dependency it trusts — so the suite spawns the published entry point and
  performs a real initialize / tools/list / tools/call exchange, including the
  cases that wedge clients: never answering a notification, and returning tool
  failures as results with `isError` rather than as JSON-RPC errors, since a
  model can read the former and act on it.

  Bundled with esbuild rather than emitted by `tsc`, because NodeNext demands
  explicit `.js` extensions the extension source does not use, and rewriting
  every import in `src/core` so one entry point could be published is the wrong
  trade. Bundling also brings the OpenCC dictionaries along, so `npx openread`
  works on a machine with nothing installed.

### Fixed

- **The README promised `npx openread`, which does not work.** The name is
  unclaimed on npm, so that line described a package that does not exist —
  the same class of unverifiable claim this project removed from the README in
  2.3.0. The documented commands are now the ones that work today
  (`npm install -g github:0Smallcat0/OpenRead`, verified by installing into an
  empty directory and translating with it), and the release workflow publishes
  to npm on tag as soon as an `NPM_TOKEN` secret exists, with provenance.

- **`npm install openread` failed outright, for everyone.** `postinstall` ran
  `wxt prepare`, and npm runs `postinstall` on the _consumer's_ machine, where
  `wxt` is a devDependency that is not there. Every install — and every
  `npx` — would have died at that line. It is now `prepare`, which npm runs
  for local development and for git installs and never for a dependency.

  Caught by installing the packed tarball into an empty directory and running
  the binary, which is now part of CI as `npm pack --dry-run`. Nothing in a
  test suite that runs inside the repository could have found it.

- **The MCP server exited while still generating.** Closing stdin ended the
  process immediately, so a piped batch of requests silently lost its last
  answer. In-flight work is now drained first.

## [2.5.0] - 2026-08-03

### Changed

- **`OLLAMA_ORIGINS` is no longer a step.** Setup is now `ollama pull qwen3`
  and `ollama serve`. Nothing else.

  Every install used to begin with an environment variable — set three
  different ways on three platforms — followed by a server restart, before
  a single translation could succeed. It was the largest cost in the project
  and it had nothing to do with translation. Version 2.3.0 responded by
  detecting the failure and printing a good error message with a copyable fix,
  which is a better way to describe a wall than to remove one.

  Measured against a stock server: a request with no `Origin` header gets
  **200**, the same request with `Origin: chrome-extension://…` gets
  **403**. The header is the entire wall. One `declarativeNetRequest` session
  rule strips it, and the step stops existing.

  The scoping is the part that mattered to get right, because `Origin` is
  precisely what stops a web page from driving a local model it has no
  business touching. The rule matches only `tabIds: [-1]` — requests with
  no owning tab, meaning this extension's own service worker and pages —
  and only a `urlFilter` anchored to the configured server's origin. A request
  from a web page always carries a real tab id, so it can never match, and it
  keeps facing Ollama's own check exactly as before. Both conditions are
  pinned by tests rather than checked by eye.

  `declarativeNetRequest` therefore returns to the manifest, four releases
  after being dropped as a permission v1 declared and never used. It now has
  one job and one rule. `scripting` stays gone.

### Fixed

- **A cold-start race that would have made the above intermittent.** Installing
  the rule is asynchronous and an MV3 worker starts cold — it is woken _by_
  the first request — so that request could reach the network before the
  rule was in force and take a 403 the user did nothing to deserve. Both
  outbound paths now await the rule.

  Found by `pnpm e2e:page` against a stock server: with two blocks in flight,
  exactly one failed, every time. No unit test would have shown this; the
  suite was green before and after.

## [2.4.1] - 2026-08-03

### Fixed

- **Whole-page translation spent most of its effort on navigation.** The first
  real-browser run of the 2.4.0 feature, on Wikipedia's article for Ollama,
  collected **325 blocks — 277 of them chrome**: the sidebar, the account
  links, and the table of contents. Because the DOM puts all of that ahead of
  the article, a queue in document order translated "Create account" and
  "View history" while the reader waited on paragraph one, and a table of
  contents entry reading `4` came back as `四`.

  Two changes, both measured on live pages. Collection now scopes to the page's
  `main` / `[role="main"]` / `article` landmark when it declares one, which
  excludes chrome by construction rather than by blocklist and makes "document
  order" finally mean "reading order"; a page with no such landmark falls back
  to the whole body, unaffected. On top of that, navigational landmarks are
  skipped wherever they appear — `nav`, `header`, `footer`, `aside`, their
  ARIA equivalents, and the table-of-contents and sidebar classes that predate
  them.

  Wikipedia's Ollama article: **325 blocks → 48**. MDN's `AbortController`
  page: **135 → 24**. example.com, which declares no landmark: unchanged at 2. The first block translated goes from "Current events" to the article's
  opening sentence.

  Worth recording how this was found: 2.4.0 shipped with 70 unit tests that all
  passed, and comments explaining that block selection must not waste a local
  GPU on navigation chrome. It did anyway. jsdom has no real page to be wrong
  about — the defect was visible in the first screenshot taken through
  `pnpm e2e:page` and in no test written before it.

## [2.4.0] - 2026-08-03

### Added

- **Whole-page bilingual translation.** Until now OpenRead translated one
  selection at a time, which answers "what does this sentence say" — not "let
  me read this page", which is what most people mean when they install a
  translator. **Translate this page** in the popup, or `Ctrl+Shift+G`, now
  translates every worthwhile block; the same control stops a run in progress
  and, on an already-translated page, removes every translation.

  Three decisions are worth recording, because each one is a way the obvious
  implementation goes wrong:

  _Bilingual, not replacement._ The translation is appended under each block,
  never over it. A local 8B model is good and not perfect; leaving the original
  in place means a suspicious sentence can be checked against its source, and a
  bad translation degrades a page instead of destroying it.

  _A queue, not a flood._ Ollama serves one generation per model by default, so
  firing fifty parallel requests only builds a queue — in arrival order, which
  is not the order anyone reads in. Two requests stay in flight, over blocks in
  document order, so the page fills from the top where the reader is looking.

  _Block selection is the whole problem._ "Every element with text" translates a
  paragraph once for itself and again for each of its wrappers, spends minutes
  of a local GPU on navigation labels, and hands a model a code sample to
  translate the identifiers in. `ui/blocks.ts` takes the leaf-most prose
  element, refuses to descend into `code`/`pre`/`kbd`/form controls, honours
  `translate="no"` and `.notranslate` because a page asking not to be
  translated is the difference between a tool and a nuisance, drops blocks
  under 12 characters or with no letters in any script, and runs the same
  `shouldBypassAI` short-circuit selection uses so a block already in the
  target language costs nothing.

  Every block is independent: one failure marks one paragraph and the run
  continues, because a page is not all-or-nothing. An empty generation is
  reported as a failure rather than skipped — a silent gap reads as "already in
  my language", which is worse than an error. Running again is a no-op on
  blocks that already carry a translation, which makes the same action the
  right way to pick up content that loaded after the first pass.

  Only the top frame runs. An ad iframe doing its own pass would spend the
  user's GPU on someone else's banner and stack a second progress badge in the
  same corner.

  70 new tests, including the concurrency ceiling, the stop-mid-run path, and
  the case that would otherwise stall the whole queue forever: an MV3 worker
  killed mid-generation disconnects without ever sending `done`.

- **A browser harness, kept this time.** `pnpm e2e:page` loads the built
  extension into Chrome over CDP, drives the real popup message against a live
  page and a real local model, and asserts that translations land, the original
  survives, chrome under the length floor is skipped, and toggling again
  restores the page byte for byte.

  This closes a gap the 2.3.0 README rewrite had to admit: screenshots were
  described as "captured by the browser E2E harness" when no such harness was
  in the repository — the scripts that took them lived in a scratch directory
  and were thrown away. jsdom cannot tell you whether an extension loads,
  whether a content script is injected, or whether the service worker is awake
  when a message arrives, and all three shipped defects of the 2.2.11–2.2.13
  run were invisible without a real browser.

  Not in CI, on purpose: GitHub's runners have no GPU and no model, and a
  translation harness that stubs the model is measuring the stub.

## [2.3.0] - 2026-08-03

### Added

- **The popup now checks whether Ollama will actually answer, and says what to
  do when it will not.** Every new install has to clear the same two hurdles —
  the server running, and the server willing to answer a browser extension's
  origin — and a third that only bites later, a model name that is not
  installed. All three used to surface the same way: select text on a page,
  wait, read an error in a translation panel. The popup is where the user is
  already configuring things, so it is where the answer belongs.

  Opening it probes `/api/tags` and reports one of five states. A 403 — by far
  the most common, because Ollama refuses unknown origins and an extension is
  always an unknown origin — now comes with the exact `OLLAMA_ORIGINS` command
  for the user's platform, next to a Copy button, rather than a paragraph
  pointing at the README.

  The model field gained the list of models the server actually has. It stayed
  a text input rather than becoming a `<select>`, because the options come from
  a server that may be unreachable and a user must still be able to configure
  one before starting it; the field accepts anything and warns when what it
  holds is not installed. That warning compares `qwen3` against `qwen3:latest`
  the way Ollama resolves them, so a correctly configured server is never
  reported as broken.

  The probe is called straight from the popup instead of through the background
  worker. Translate and enrich are brokered because they originate in a content
  script, which runs in the page's origin and cannot reach localhost; the popup
  is an extension page with the same origin the worker has, so it reaches
  Ollama on exactly the terms a translation will — which is the point of a
  check — and the URL being tested never has to ride the message bus. It lives
  in its own `api/probe.ts` for a second reason: importing it from `ollama.ts`
  would have pulled that file's import graph into the popup bundle, and that
  graph reaches the OpenCC phrase tables. A megabyte of dictionaries, loaded so
  a settings panel could ask for a list of names. The popup chunk is 5.5 kB.

## [2.2.15] - 2026-07-31

### Added

- **A control-token detector in the benchmark, and the measurement behind
  leaving the pipeline alone.** Dogfooding turned up a translation reading
  `Fetch 是基於 Promise 的，且位於 /no_think 路徑下。` — the model had translated
  a chat-template control token as if it were part of the sentence. The cause is
  not model noise: Ollama's qwen3 template appends ` /no_think` to the **last
  user message** whenever a request sets `think: false`, which every OpenRead
  translation does. The extension supplies no translation context, so that last
  message is the bare source text and the token is glued directly onto the text
  the model is asked to translate.

  Nothing was filtered, because the measurements did not support it. The token
  leaked 0 times in 216 recorded generations and 0 times in 278 fresh ones swept
  over temperature (0.3 and the retry path's 0.7) and selection length. Fencing
  the source in `<target>` tags — which moves the appended token outside the
  region the model is told to translate, and reuses a shape the codebase already
  has — was implemented and scored against the shipped prompt over the 27 bench
  fixtures: chrF 46.39 versus 46.76. No gain, a slightly negative point estimate,
  and no reproducible leak to fix, so it was not shipped. A runtime filter would
  additionally need to hold an ambiguous tail across chunk boundaries
  (`/no_` + `think`), which is real machinery to add at this rate.

  What did ship is the ability to know: `hasControlTokenLeak` joins the existing
  preamble/echo/Simplified detectors and `pnpm bench` now reports a `Control
token raw→piped` column. It reads the same on both sides by design — nothing
  filters it — so the number is the incidence rate, and the decision above can be
  revisited on data rather than on memory of a single sighting.

## [2.2.14] - 2026-07-26

### Removed

- **The manual UI harness added in 2.2.11.** It existed to work around a
  limitation that no longer applies: at the time the built extension could not
  be loaded into a browser, so the only way to see the selection UI render was
  to mount the module on a plain page. Loading the extension into Chrome for
  Testing removed that constraint, and every finding since — the page-aware
  palette, the icon reappearing over the panel, the 403 message, the PDF
  startup sweep — came from the real extension rather than the harness, which
  has not been used since the day it was written. Keeping an unused second way
  to exercise the same module is maintenance surface with no reader. Goes with
  it: the `harness` script, the direct `vite` dependency it needed, and the
  launch configuration that only pointed at it.

## [2.2.13] - 2026-07-26

### Fixed

- **A PDF opened as the browser's startup page stayed in Chrome's own viewer.**
  `chrome.tabs.onUpdated` only sees navigations that happen while the MV3 worker
  is alive; launch the browser straight onto a PDF — a restored session, or a
  `.pdf` link clicked from outside Chrome — and the navigation is already past
  `loading` before the worker starts. Measured in a real browser: launching with
  a PDF as the startup page landed in the built-in viewer every time, while
  browsing first and then opening the same PDF worked. The worker now sweeps the
  open tabs on `onStartup` and `onInstalled`, honouring the same file-scheme
  permission check and the same don't-redirect-the-viewer guard.

## [2.2.12] - 2026-07-26

Found by running the **real extension** in a real browser — loaded from the
command line into a throwaway profile, driven over CDP with real mouse input,
against a real page and a real Ollama. The unit tests were green throughout;
none of these three is reachable from jsdom.

### Fixed

- **The panel picked its colours from the operating system, not the page.**
  `palette()` asked `prefers-color-scheme`, which answers a different question
  than the one its own comment posed. Most sites are light-only whatever the OS
  preference says, so a dark system theme put a dark panel on a light page —
  precisely the mismatch the palette exists to prevent. It now samples the
  background actually painted behind the selection and falls back to the media
  query only when the whole chain is transparent.
- **Clicking the 文 button made it come back on top of the panel it opened.**
  The button acts on `mousedown`; the `mouseup` that follows still reaches the
  document, where it read as "the user finished selecting" — and the selection
  is of course still there, so the icon was redrawn over the panel. A
  synthesised `mousedown` never produces the matching `mouseup`, which is why
  the suite never saw it.
- **The likeliest first-run failure said nothing useful.** Ollama refuses
  requests from origins it was not told about, and a browser extension is
  always such an origin; it answers **403 with an empty body**, which surfaced
  as `⚠️ Ollama 403: {}`. The client now names the cause and the setting
  (`OLLAMA_ORIGINS="chrome-extension://*"`). The actionable wording already
  existed for the network-failure case and simply never covered this one.

## [2.2.11] - 2026-07-26

Everything below was found by running the UI in a real browser. The unit tests
were green throughout — jsdom computes no geometry, so no test in the suite
could have seen any of it.

### Added

- **A manual harness for the selection UI** (`pnpm harness`). It mounts
  `mountSelectionTranslator` on a plain Vite page with `chrome` stubbed and the
  translation faked, so the parts that only exist once a rendering engine is
  involved — layout, focus, `prefers-color-scheme` — can be exercised by hand.
  Not the extension: the shortcut and the content-script wiring still need the
  real thing loaded.

### Fixed

- **The panel hung off the left edge of a narrow viewport.** `min-width` and
  `max-width` are content-box by default, so the 30px of horizontal padding was
  added on top of the 90vw cap: measured at **370px wide in a 375px viewport**,
  and once the right-edge branch pushed it back it sat at **left: -14px**. With
  `box-sizing: border-box` it measures 338px and sits at left: 18px. Desktop is
  unchanged (400px, on-screen in both the normal and right-edge cases).

### Verified

- Enter on the 文 button opens the panel and **moves focus into it**; Escape
  closes both panel and icon; the panel is a `role="dialog"` whose content is an
  `aria-live` region — all confirmed with real key events, not synthesised ones.
- The dark palette actually applies under `prefers-color-scheme: dark`
  (`#1f1f1f` / `#e8e8e8`), and its contrast ratios were **computed from the
  rendered colours** rather than trusted from a comment: body text 13.45:1,
  close button 6.27:1.

## [2.2.10] - 2026-07-26

### Added

- **`pnpm bench -- --repipe`** re-scores the recorded benchmark generations
  through the current pipeline without asking the models for new ones. The
  checkpoint already stored what the model emitted separately from what the
  pipeline made of it, so a change to the assembler can be measured against
  identical model output — the pipeline's effect isolated from sampling noise.
  It also drops the judge scores it invalidated, so a report can never mix
  scores from two different pipelines.

### Changed

- **The benchmark now describes the shipped pipeline.** Its numbers were
  produced by whatever was checked out on 2026-07-10 — before phrase-safe
  conversion, the corrected script markers, the adaptive buffer and echo
  removal. Re-piped: 17 of 216 generations changed. Preamble, echo and
  Simplified leakage are now **0% across every model × prompt cell** after the
  pipeline (deepseek-r1's naive-prompt Simplified leakage: 14.8% → 0%), and the
  pipeline **adds** chrF on six of eight cells rather than costing it —
  llama3.1's naive prompt moved from −0.3 to +1.0, with −0.1 the worst cell.
  The "reliability costs 0.3–0.5 chrF" claim in the README and
  `docs/BENCHMARK.md` was true of the old assembler and is now retired.

## [2.2.9] - 2026-07-26

### Added

- **Tests for the background service worker**, the last part of the extension
  with real behaviour and no coverage. It is thin but not trivial: it owns the
  streaming broker's cancellation, the only place a network failure becomes
  something a user can act on, PDF routing, and the keyboard command. Twenty
  cases drive the listeners it registers — chunk relay and `done`, the base URL
  being read from storage rather than taken off the message bus, a `TypeError`
  turning into the "is Ollama running, is `OLLAMA_ORIGINS` set" message, other
  errors passing through verbatim, an abort staying silent so a replaced
  selection does not put a warning in the panel, a new request aborting the
  previous one, a disconnect aborting in-flight work, `.pdf` redirection
  including the file-scheme permission check and the don't-redirect-the-viewer
  case, the command reaching the active tab and surviving a tab with no
  listener, and the enrichment round-trip falling back to `null` so a capture is
  never lost to it.
- Coverage now includes `src/entrypoints/background.ts`: **211 tests**, 95%
  function and 94% line coverage overall, with the background worker itself at
  100% function / 98% line.

## [2.2.8] - 2026-07-26

### Added

- **A keyboard shortcut — `Ctrl+Shift+Y` (`Cmd+Shift+Y` on macOS) — translates
  the current selection.** Remappable at `chrome://extensions/shortcuts`, and it
  needs no extra permission. It exists because the floating 文 icon is not a
  route a keyboard user can take: reaching it means tabbing to an element
  appended at the end of `<body>`, past everything else on the page.

### Fixed

- **The 文 icon never appeared for a selection made with the keyboard.**
  Shift+Arrow, Shift+Home/End/PageUp/PageDown and Ctrl+A change the selection
  without ever producing a `mouseup`, which was the only thing that offered the
  icon — so the button's own keyboard support, added in 2.2.2, was unreachable
  by exactly the people who needed it. Those keys now offer the icon too.

## [2.2.7] - 2026-07-26

The offline eval was scoring a code path the product does not run. Fixing the
measurement exposed real leaks in the shipped one.

### Fixed

- **The reluctant buffer flushed mid-artifact.** Twelve characters is shorter
  than the things it exists to catch, so `Here is the translation: 關閉前…`
  flushed at `Here is the`, the cleaner never saw the colon it splits on, and
  `translation: 關閉前…` streamed to the panel. Likewise `<think>The user is
asking…` flushed at `<think>The u` and leaked the rest of the thinking. The
  hold is now **adaptive**: it extends only while a preamble has not reached its
  delimiter, a `<think>` block is unclosed, or an echo of the selection is still
  arriving — and is capped at 400 characters so first paint cannot stall.
  Measured on real qwen3 output, **clean translations are held for exactly as
  many characters as before** (15, 15, 15, 3, 5 — identical with the check on
  and off); only artifact-shaped openings wait longer.
- **Input echo was never removed in production.** `stripEcho` lived in
  `cleanTranslationOutput`, which the streaming path does not call — the panel
  showed `Hello world 你好世界` in full. `StreamAssembler` now takes the source
  and strips a leading echo of it, along with the whitespace the removal leaves
  behind.
- **Quote unwrapping never ran either.** The cleaner was invoked only when
  `isAIThinking` fired; it now runs unconditionally on the opening, which is a
  no-op when no narration pattern matches.
- A line break falling exactly at the flush point is preserved. Both cleaners
  trim, so a multi-line translation used to lose its first newline.

### Changed

- **`pnpm eval` replays fixtures through the shipped `StreamAssembler`** in
  3-character deltas instead of calling a whole-output cleaner the extension
  never executes. Scored against the real path, the previous code left 8.7%
  preamble and 8.7% echo — both of which the eval reported as 0%. With the fixes
  above the shipped path reaches 0% on all three metrics, and the number now
  describes the product.

## [2.2.6] - 2026-07-26

### Changed

- **A capture now reports "Sent to Obsidian ↗" rather than "Saved ✓".** Handing
  a URL to the OS protocol handler returns no completion signal, so if Obsidian
  is not installed — or declines the URL — nothing happens and the page is
  never told. The old wording claimed a save that the extension cannot observe.

### Removed

- **`translateText`, dead since the UI never used it.** It was exported and
  documented as "the sequential retry fallback", but nothing in `src/` called
  it; the retry added in 2.2.4 re-streams instead. Removing it also revealed
  that `cleanTranslationOutput` — which the offline eval calls "the exact
  transform the production pipeline applies" — is not reachable from any
  shipped path either. That is tracked as the next fix; the eval's numbers are
  not restated here until the code they describe actually runs.

## [2.2.5] - 2026-07-25

### Fixed

- **A selection over 5,000 characters made the 文 icon simply not appear.** No
  icon, no panel, no message — selecting a whole page or a full PDF column read
  as the extension having stopped working. The icon now appears for any
  realistic selection; above 5,000 characters the panel translates the leading
  passage and says exactly how much of the selection that was, and a capture
  records the passage that was actually translated. Measured for context: a
  4,700-character selection already takes ~21 s end to end, so translating a
  whole page silently was never the right default either.

## [2.2.4] - 2026-07-25

### Fixed

- **A generation that produced nothing left the panel frozen on
  "Translating…".** No chunk ever arrives, so the placeholder was never
  replaced — and a whitespace-only generation showed an empty box instead. This
  is a measured failure mode, not a hypothetical: the benchmark caught
  reasoning models spending an entire generation on hidden thinking. An empty
  result now retries once at a looser sampling temperature, and if the retry is
  also empty the panel names the model and suggests what to change. Transport
  errors are deliberately _not_ retried — their message is already actionable,
  and retrying a timeout would only double the wait.

### Added

- **Tests for the selection and capture UI**, the two largest untested surfaces
  in the repo and the only parts the user actually touches. They run against a
  real DOM (jsdom) with a stubbed extension port, and assert on what the panel
  shows and where a capture actually goes — streaming, empty-generation retry,
  transport errors, same-language short-circuit, Escape and close-button
  dismissal, keyboard activation and focus, ARIA wiring, the `obsidian://new`
  URI, the clipboard fallback and its `execCommand` path, and the best-effort
  enrichment round-trip.
- Coverage now includes `src/ui` alongside `src/core`: 93% function and 92%
  line coverage over 175 tests, up from 150 tests scoped to the core alone.

## [2.2.3] - 2026-07-25

Found by driving the shipped pipeline against a live Ollama over the kinds of
text a user actually selects, and watching what the panel would show.

### Fixed

- **A wedged server left the panel translating forever.** `translateStream` had
  no timeout of its own — only the port's `AbortController`, which fires on
  disconnect, not on a stalled server. Measured against a server that accepts
  the connection and then sends nothing: still pending after 20 s, and it would
  have stayed pending for the lifetime of the service worker. Both the request
  and each stream read are now bounded by an **idle** timeout
  (`DEFAULT_IDLE_TIMEOUT_MS`, 60 s) that resets on every chunk, so a long
  selection may stream for minutes while a silent server is caught in one
  window. The failure is reported as an error the user can act on rather than
  being swallowed as a cancellation.
- **A timed-out stream leaked its socket.** The reader was released but never
  cancelled, leaving the underlying connection open; it is now cancelled on
  every exit path.
- **"Translating…" no longer sits there unexplained.** The first request after
  a browser restart loads the model into VRAM — measured at **12.3 s** on the
  benchmark rig against ~180 ms for every request after it. After 4 seconds
  without a chunk the panel now says what it is waiting for and why, instead of
  reading as a hang.

## [2.2.2] - 2026-07-25

### Fixed

- **The selection UI is reachable without a mouse.** The floating 文 trigger was
  a `<div>` with a `mousedown` handler — invisible to keyboard and assistive
  tech. It is now a `<button>` with an accessible name, activated by Enter or
  Space, and the panel can be dismissed with Escape (previously only a click
  outside would close it). Keyboard activation moves focus into the panel,
  because removing the trigger would otherwise drop focus to `<body>`; mouse
  activation deliberately does not steal focus from the page.
- **Streaming translations are announced to screen readers.** The panel is a
  `role="dialog"` with an accessible name, its content is an `aria-live` region
  so text arriving chunk by chunk is actually read out, and the popup's status
  line is a live region too.
- **Contrast failures across the UI.** The panel close button (3.54:1), the
  popup's primary button label (3.68:1), the capture button, and the popup's
  input borders (1.61:1) all sat below their WCAG minimums; each is corrected,
  with the measured ratio recorded next to the value.
- **The injected panel follows the page's colour scheme.** It hardcoded a white
  sheet with near-black text, which is blinding on a dark site or dark PDF
  viewer. It now picks a contrast-checked light or dark palette, as does the
  popup's status line.
- **Panel placement near the right edge and on narrow viewports.** The
  right-edge fit test compared against 320px while the panel was 400px wide, so
  a selection near the margin was judged to fit and then overflowed; both now
  read one `PANEL_MIN_WIDTH` constant. `min-width:400px` also beat
  `max-width:min(600px,90vw)` below ~440px of viewport and pushed the panel
  off-screen; it is clamped to the same 90vw ceiling.
- **Saving settings can no longer fail silently.** A rejected `saveSettings`
  left the popup's status line blank, which reads exactly like "nothing
  happened yet"; failures now show `Save failed`.

### Changed

- Capture button and status strings are English (`＋ Save to Obsidian`,
  `Saving…`, `Saved ✓`), matching the rest of the extension chrome.
- Dropped the unused `closeButtonClass` option from `mountSelectionTranslator`;
  nothing referenced the class it applied.

## [2.2.1] - 2026-07-25

Two correctness fixes in the Chinese-conversion path, both found by replaying
the recorded benchmark generations rather than by reading the code.

### Fixed

- **Phrase-safe streaming Simplified→Traditional conversion.** `s2twp` maps
  whole phrases, so converting each stream chunk independently mistranslated
  any phrase a chunk boundary split — `数据` + `库` became `數據庫` instead of
  `資料庫`, `端口` stayed `端口` instead of `埠`, and `下游` split in half became
  `下遊`. `TraditionalTWTransform` (`src/core/zh-convert.ts`) holds the
  ambiguous tail back until enough context has arrived, so streamed output is
  byte-identical to converting the finished text in one call. Replaying the 216
  recorded benchmark generations at chunk sizes 1–8: **13.0% of generations
  converted differently before the fix, 0.0% after.**
- **Script-marker sets are now derived from the OpenCC dictionaries** rather
  than hand-written, fixing errors in both directions. Simplified merged
  系/係/繫 and 游/遊 (among others) into single forms that are ordinary
  Traditional characters, so correct output such as `系統` and `下游` scored as
  Simplified leakage — the source of the benchmark's "residual 7.4%" — and
  `shouldBypassAI` sent already-Traditional selections to the model for no
  reason. In the other direction, common Simplified characters (发, 时, 们, 开,
  软, 机) were missing outright, so `计算机软件开发` was not detected as
  Simplified at all. `pnpm gen:markers` regenerates
  `src/core/zh-markers.generated.ts` (3,797 Simplified-only and 3,195
  Traditional-only characters); `language.test.ts` fails if it drifts from the
  installed dictionaries. Offline eval Simplified-leakage detection rises from
  38.1% to **42.9%** of applicable fixtures, still fully removed by the
  pipeline.

### Changed

- `StreamAssembler`'s `transform` option takes a stateful `ChunkTransform`
  (`push`/`end`) instead of a pure function, so a transform can hold text back
  across chunk boundaries; `StreamAssembler.end()` flushes it.

## [2.2.0] - 2026-07-10

Research-grade evaluation: live model benchmark, judge calibration, and a
structured-output study — which caught and fixed a product-breaking
reasoning-model bug.

### Added

- Live translation benchmark (`pnpm bench`): 4 local models × 2 prompt
  conditions × 27 curated EN→zh-TW fixtures with Taiwan-convention references;
  reference-based chrF (sacrebleu-cross-validated), artifact rates,
  TTFT-net/TTFT-UI latency, tokens/s, and a JSON-schema-constrained LLM judge
  → `eval/BENCHMARK-RESULTS.md`
- Judge calibration workflow (`pnpm bench:agreement`): seeded blind labeling
  page + Cohen's κ (plain & quadratic-weighted) judge↔human → `eval/AGREEMENT.md`.
  Measured over 40 human labels: weighted κ 0.526 adequacy (moderate),
  0.267 fluency / 0.213 localization (weak — judge over-lenient on Taiwan
  terminology; report reads those axes as upper bounds)
- Structured-output study (`pnpm eval:structured`): prompt-only vs
  schema-constrained decoding across 4 models × 16 realistic capture excerpts,
  with a failure-shape taxonomy → `eval/STRUCTURED-RESULTS.md`
- `docs/BENCHMARK.md` — methodology, found-bug case study, limitations

### Changed

- **Ollama client migrated from OpenAI-compat `/v1/chat/completions` to native
  `/api/chat` with `think: false`** (now requires Ollama ≥ 0.9)
- Default model `qwen2.5` → `qwen3:latest` — chosen by the benchmark (best
  chrF at the lowest TTFT of the models measured)
- Capture enrichment now uses schema-constrained decoding (Ollama `format`) —
  the study measured it closing the last unreliable tail at zero latency
  cost; the tolerant parser remains as content hygiene

### Fixed

- Reasoning models (qwen3 family, deepseek-r1) produced **no visible output**
  through the compat endpoint — chain-of-thought consumed the entire
  generation in a separate `reasoning` field (measured: 99 s / 4,055 tokens /
  0 visible characters on one fixture; 1.6 s after the fix). Found by the
  benchmark harness.

## [2.1.0] - 2026-07-09

Switch to local Ollama backend.

### Added

- Local Ollama backend (OpenAI-compatible streaming)
- Ollama server URL setting

### Changed

- Replaced the OpenRouter cloud API + API-key setting with a local Ollama server URL — translation is now fully on-device

### Removed

- The API-key input and all cloud/BYOK framing

## [2.0.0] - 2026-07-09

Complete rebuild.

### Added

- TypeScript (strict) + WXT MV3 framework
- Vitest unit suite (57 tests) + offline eval harness (`pnpm eval`)
- OpenCC `s2twp` phrase-level Simplified→Traditional conversion
- Per-request `AbortController` cancellation for streaming
- Typed message protocol
- ESLint + Prettier + GitHub Actions CI

### Changed

- Reliability layer (preamble/echo/quote stripping) extracted into a pure, tested core
- API key now read by the background worker from storage instead of travelling over the message bus

### Fixed

- PDF.js worker path (`pdf.worker.js` → `pdf.worker.mjs`) that broke local PDF rendering
- Simplified→Traditional corruption (`界面→界麵`, `公里→公裡`) from v1's hand-rolled character map

### Removed

- Unused `scripting` + `declarativeNetRequest` manifest permissions
- Orphaned YouTube subtitle code
- ~90% duplicated selection UI between web and PDF (now one shared module)

## [1.0.0]

Initial release. Hand-rolled JS extension with streaming translation for web and PDF.
