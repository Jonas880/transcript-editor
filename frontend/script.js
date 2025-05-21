// --- Constants ---
const API_BASE_URL = "http://localhost:8000"; // Your FastAPI backend URL
const CHARS_PER_LINE_ESTIMATE = 80; // Adjusted for potentially wider font
const PIXELS_PER_LINE = 22; // Adjusted for line height
const BASE_TEXT_AREA_HEIGHT = 10; // Padding adjustment
const MIN_TEXT_AREA_HEIGHT = 60;
const MAX_TEXT_AREA_HEIGHT = 400;

// --- DOM Elements ---
const transcriptFileInput = document.getElementById('transcript-file');
const audioFileInput = document.getElementById('audio-file');
const transcriptFileInfo = document.getElementById('transcript-file-info');
const audioFileInfo = document.getElementById('audio-file-info');
const targetWordsInput = document.getElementById('target-words');
const fixTyposCheckbox = document.getElementById('fix-typos');
const translateNorwegianCheckbox = document.getElementById('translate-norwegian');
const processButton = document.getElementById('process-button');
const loadingIndicator = document.getElementById('loading-indicator');
const statusMessage = document.getElementById('status-message'); // General status (like success)
const errorMessage = document.getElementById('error-message'); // Specific errors
const initialInfo = document.getElementById('initial-info');
const resultsSection = document.getElementById('results-section');
const segmentsHeader = document.getElementById('segments-header');
const editorStatusDisplay = document.getElementById('editor-status'); // Renamed from editorStatus
const targetWordsDisplay = document.getElementById('target-words-display');
const segmentsContainer = document.getElementById('segments-container');
const exportFormatSelect = document.getElementById('export-format');
const exportButton = document.getElementById('export-button'); // Renamed from downloadButton
const exportFilename = document.getElementById('export-filename'); // Renamed from downloadFilename
const comparisonExpander = document.getElementById('comparison-expander');
const originalTextPreview = document.getElementById('original-text-preview');
const editedTextPreview = document.getElementById('edited-text-preview');
// const audioPlayer = document.getElementById('audio-player'); // Removed global player

// --- State ---
let currentSessionId = null;
let segmentData = []; // Array to hold { index, start, end, original_text, current_text, gpt_error, is_highlighted, blobUrl: null }
let currentEditorStatus = "None";
let currentTargetWords = 60;
let activeSegmentIndex = -1; // Index of the currently selected/playing segment
// let isPlaying = false; // Not needed for native controls
// let audioTimeUpdateListener = null; // Not needed
// let isDraggingProgressBar = false; // Not needed
// let currentDragIndex = -1; // Not needed
// let lastSeekTime = -1; // Not needed

// --- Initialization ---
function init() {
    // Ensure elements exist before adding listeners
    if (transcriptFileInput) transcriptFileInput.addEventListener('change', handleFileChange);
    if (audioFileInput) audioFileInput.addEventListener('change', handleFileChange);
    if (processButton) processButton.addEventListener('click', handleProcess);
    if (exportButton) exportButton.addEventListener('click', handleExport);
    // Remove segment navigation listeners
    // if (prevSegmentButton) prevSegmentButton.addEventListener('click', () => selectSegment(activeSegmentIndex - 1));
    // if (nextSegmentButton) nextSegmentButton.addEventListener('click', () => selectSegment(activeSegmentIndex + 1));
    // Removed global audio player listeners
    document.addEventListener('keydown', handleGlobalKeyDown);
    // Removed global pointerup listeners

    checkProcessButtonState(); // Initial check
    setInfoMessage("⬆️ Select Transcript and Audio files...", "info"); // Initial message
}

// --- UI Update Functions ---

function showLoading(isLoading, message = "Processing...") {
    if (!loadingIndicator || !processButton) return; // Add checks
    if (isLoading) {
        loadingIndicator.querySelector('span').textContent = message;
        loadingIndicator.style.display = 'flex';
        processButton.disabled = true;
        processButton.style.display = 'none'; // Hide button while loading
        clearStatus(); // Clear previous status/errors
    } else {
        loadingIndicator.style.display = 'none';
        processButton.disabled = false;
        processButton.style.display = 'inline-block'; // Show button again
        checkProcessButtonState(); // Re-check if files are still selected
    }
}

function setStatus(message, type = 'info') {
    if (!statusMessage || !initialInfo) return; // Add checks
    clearError();
    statusMessage.textContent = message;
    statusMessage.className = `status ${type}`;
    statusMessage.style.display = message ? 'block' : 'none';
    initialInfo.style.display = 'none';
}

function setError(message) {
    if (!errorMessage || !initialInfo) return; // Add checks
    clearStatus();
    errorMessage.textContent = `Error: ${message}`;
    errorMessage.style.display = 'block';
    initialInfo.style.display = 'none';
}

function setInfoMessage(message, type = 'info') {
    if (!initialInfo) return; // Add check
    clearStatus();
    clearError();
    initialInfo.textContent = message;
    initialInfo.className = `status ${type}`;
    initialInfo.style.display = message ? 'block' : 'none';
}

function clearStatus() {
    if (statusMessage) {
        statusMessage.textContent = '';
        statusMessage.style.display = 'none';
    }
}

function clearError() {
    if (errorMessage) {
        errorMessage.textContent = '';
        errorMessage.style.display = 'none';
    }
}

// MODIFIED: Calculate text area height based on scrollHeight
function adjustTextAreaHeight(textarea) {
    if (!textarea) return;

    // Temporarily reset height to 'auto' to allow scrollHeight to reflect the actual content size
    textarea.style.height = 'auto';

    // Calculate the scroll height (content height)
    let scrollHeight = textarea.scrollHeight;

    // Apply min/max constraints (consider border/padding if box-sizing is border-box, which it is)
    const computedStyle = getComputedStyle(textarea);
    const borderTopWidth = parseInt(computedStyle.borderTopWidth, 10);
    const borderBottomWidth = parseInt(computedStyle.borderBottomWidth, 10);
    const paddingTop = parseInt(computedStyle.paddingTop, 10);
    const paddingBottom = parseInt(computedStyle.paddingBottom, 10);

    // We want the *outer* height to be within MIN/MAX
    // scrollHeight includes padding but not border
    const contentHeight = scrollHeight + borderTopWidth + borderBottomWidth;

    const finalHeight = Math.max(MIN_TEXT_AREA_HEIGHT, Math.min(contentHeight, MAX_TEXT_AREA_HEIGHT));

    textarea.style.height = `${finalHeight}px`;
    // console.log(`Adjusted height for ${textarea.id} to ${finalHeight}px (scrollHeight: ${scrollHeight})`);
}

// --- Event Handlers ---

function handleFileChange(event) {
    const input = event.target;
    const infoSpan = input === transcriptFileInput ? transcriptFileInfo : audioFileInfo;
    if (!infoSpan) return; // Add check

    if (input.files.length > 0) {
        infoSpan.textContent = input.files[0].name;
        infoSpan.style.color = '#212529'; // Reset color if previously error
    } else {
        infoSpan.textContent = input === transcriptFileInput ? 'Please select a .txt file' : 'Please select an audio file';
        infoSpan.style.color = '#6c757d';
    }
    checkProcessButtonState();
}

function checkProcessButtonState() {
    if (!processButton || !transcriptFileInput || !audioFileInput || !loadingIndicator || !initialInfo) return; // Add checks

    const canProcess = transcriptFileInput.files.length > 0 && audioFileInput.files.length > 0;
    // Only change button state if not currently loading
    if (loadingIndicator.style.display === 'none') {
         processButton.disabled = !canProcess;
    }

    // Update info message based on state
    if (initialInfo.style.display !== 'none') { // Only update if initial info is visible
        if (canProcess) {
             setInfoMessage("➡️ Ready to process. Adjust options or click 'Process Files'.", "info");
        } else if (transcriptFileInput.files.length === 0) {
             setInfoMessage("⬆️ Select a Transcript file (.txt).", "info");
        } else {
             setInfoMessage("⬆️ Select an Audio file.", "info");
        }
    }
}

async function handleProcess() {
    if (!transcriptFileInput || !audioFileInput || !targetWordsInput || !fixTyposCheckbox || !translateNorwegianCheckbox) return;

    const transcriptFile = transcriptFileInput.files[0];
    const audioFile = audioFileInput.files[0];

    if (!transcriptFile || !audioFile) {
        setError("Please select both transcript and audio files.");
        return;
    }

    // Reset previous results
    resetResults();

    const formData = new FormData();
    formData.append('transcript_file', transcriptFile);
    formData.append('audio_file', audioFile);
    currentTargetWords = targetWordsInput.value;
    formData.append('target_words', currentTargetWords);
    formData.append('fix_typos', fixTyposCheckbox.checked);
    formData.append('translate_norwegian', translateNorwegianCheckbox.checked);

    showLoading(true, "Uploading & Processing...");

    try {
        const response = await fetch(`${API_BASE_URL}/api/process`, {
            method: 'POST',
            body: formData,
        });

        const result = await response.json();

        if (!response.ok) {
            const errorDetail = result?.detail || response.statusText;
            throw new Error(` ${errorDetail} (Status: ${response.status})`);
        }

        currentSessionId = result.session_id;
        currentEditorStatus = result.editor_status;

        if (!Array.isArray(result.segments)) {
             throw new Error("Invalid data format received from server (segments missing or not an array).");
        }

        segmentData = result.segments.map((seg, index) => ({
            ...seg,
            index: index,
            original_text: seg.text, // Keep original for comparison
            current_text: seg.text, // Start with current = original
            is_highlighted: false, // Initialize highlight state
            blobUrl: null // Initialize blobUrl
        }));

        // ---- NEW: Preload audio before rendering ----
        showLoading(true, `Processing complete. Preloading ${segmentData.length} audio segments...`);
        // Pass segmentData so it can be updated with blobUrls
        await preloadAllAudio(segmentData, currentSessionId);
        // ---- END NEW ----

        setStatus(`Processing complete! ${segmentData.length} segments generated.`, "success");
        renderSegments(); // Render only after preloading is done
        showLoading(false);

    } catch (error) {
        setError(`Processing failed: ${error.message}`);
        showLoading(false);
        resetResults(); // Ensure UI is cleared on error
    }
}

// ---- MODIFIED FUNCTION: Preload all audio segments using fetch ----
async function preloadAllAudio(segments, sessionId) {
    console.log(`Starting preload for ${segments.length} segments in session ${sessionId} using fetch`);
    const preloadPromises = segments.map((seg, index) => {
        return new Promise(async (resolve, reject) => { // Make inner function async
            const audioUrl = `${API_BASE_URL}/api/audio/${sessionId}/${index}`;
            try {
                const response = await fetch(audioUrl);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status} for segment ${index}`);
                }
                const blob = await response.blob();
                const blobUrl = URL.createObjectURL(blob);

                // Store the Blob URL directly in the segment data
                if (segments[index]) {
                     segments[index].blobUrl = blobUrl;
                     // console.log(`Segment ${index} fetched and Blob URL created: ${blobUrl}`);
                     resolve({ index, status: 'loaded', blobUrl: blobUrl });
                } else {
                     // Should not happen if called correctly, but safety check
                     console.error(`Segment data missing for index ${index} during preload`);
                     reject(new Error(`Segment data missing for index ${index}`));
                }

            } catch (error) {
                console.error(`Error fetching or creating blob for segment ${index}:`, error);
                // Resolve with error status to avoid blocking Promise.all,
                // but mark the segment so we know it failed.
                 if (segments[index]) { segments[index].blobUrl = 'error'; } // Mark as error
                 resolve({ index, status: 'error', error: error });
            }
        });
    });

    try {
        const results = await Promise.all(preloadPromises);
        const errors = results.filter(r => r.status === 'error');
        if (errors.length > 0) {
            console.warn(`Finished preloading with ${errors.length} fetch errors.`);
            // Maybe show a warning to the user?
            // setError(`Warning: Failed to preload ${errors.length} audio segments. They might not play correctly.`, 'warning'); // Example message
        } else {
            console.log("All audio segments fetched and preloaded successfully via Blobs.");
        }
        // --- Important: Revoke old blob URLs if reprocessing ---
        // (Need to handle this carefully - maybe revoke URLs in resetResults?)

    } catch (error) {
        console.error("An unexpected error occurred during audio fetch preloading:", error);
        throw new Error("Audio preloading failed."); // Re-throw to be caught by handleProcess
    }
}
// ---- END MODIFIED FUNCTION ----

function handleExport() {
    if (!exportFormatSelect || !exportFilename) return; // Add checks
    if (segmentData.length === 0) return;

    const format = exportFormatSelect.value;
    let content = "";
    let filename = "";
    const baseFilename = `transcript_${currentSessionId ? currentSessionId.substring(0, 8) : 'export'}`;

    if (format === 'txt') {
        // Add [HIGHLIGHT] prefix for highlighted segments in plain text
        content = segmentData.map(seg => {
            const prefix = seg.is_highlighted ? '[HIGHLIGHT] ' : '';
            return prefix + seg.current_text;
        }).join(' \n\n');
        filename = `${baseFilename}_plain.txt`;
    } else if (format === 'timestamped') {
        // Keep timestamped format clean (no prefix)
        content = segmentData.map(seg => `[${seg.start} --> ${seg.end}]\n${seg.current_text}`).join('\n\n');
        filename = `${baseFilename}_timestamped.txt`;
    } else {
        console.error("Unknown export format:", format);
        return;
    }

    // Basic cleaning (replace multiple spaces/newlines, trim)
    content = content.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    exportFilename.textContent = `Downloaded: ${filename}`;
}

function resetResults() {
    if (!segmentsContainer || !resultsSection || !exportButton || !exportFilename || !originalTextPreview || !editedTextPreview || !comparisonExpander) return;

    // --- NEW: Revoke old Blob URLs to free memory ---
    segmentData.forEach(seg => {
        if (seg.blobUrl && seg.blobUrl.startsWith('blob:')) {
            try {
                URL.revokeObjectURL(seg.blobUrl);
                // console.log(`Revoked Blob URL for segment ${seg.index}`);
            } catch (e) {
                console.warn(`Could not revoke Blob URL: ${seg.blobUrl}`, e);
            }
        }
    });
    // --- END NEW ---

    currentSessionId = null;
    segmentData = []; // Clear data *after* revoking
    activeSegmentIndex = -1;
    // Removed state resets for playback/drag
    segmentsContainer.innerHTML = '';
    resultsSection.style.display = 'none';
    exportButton.disabled = true;
    exportFilename.textContent = '';
    originalTextPreview.value = '';
    editedTextPreview.value = '';
    comparisonExpander.style.display = 'none';
}

// --- Segment Rendering & Interaction ---

function renderSegments() {
    if (!segmentsContainer || !resultsSection || !exportButton || !comparisonExpander || !originalTextPreview || !editedTextPreview) return; // Add checks

    segmentsContainer.innerHTML = ''; // Clear previous segments

    if (segmentData.length === 0) {
        resultsSection.style.display = 'none';
        return;
    }

    resultsSection.style.display = 'block';
    exportButton.disabled = false;
    segmentsHeader.textContent = `Transcript Segments (${segmentData.length})`;
    targetWordsDisplay.textContent = `Target words/segment: ~${currentTargetWords}`;
    editorStatusDisplay.textContent = `Editor Status: ${currentEditorStatus}`;

    segmentData.forEach((segment, index) => {
        // ---> REMOVE LOGGING HERE <--- //
        // console.log(`Rendering segment ${index}:`, segment); // Log the whole segment object

        const segmentElement = document.createElement('div');
        segmentElement.className = 'segment';
        segmentElement.id = `segment-${index}`;
        segmentElement.tabIndex = 0; // Make segment focusable

        const segmentMeta = document.createElement('div');
        segmentMeta.className = 'segment-meta';

        const timestamps = document.createElement('span');
        timestamps.className = 'segment-timestamps';
        // ---> USE parseTime HERE <--- //
        timestamps.textContent = `${formatTime(parseTime(segment.start))} - ${formatTime(parseTime(segment.end))}`;

        const segmentMetaRight = document.createElement('div');
        segmentMetaRight.className = 'segment-meta-right';

        // Create Highlight Button
        const highlightButton = document.createElement('button');
        highlightButton.className = 'highlight-button';
        highlightButton.title = 'Toggle Highlight (Cmd/Ctrl+H)';
        highlightButton.textContent = '⭐'; // Changed from 'H'
        highlightButton.onclick = (e) => {
            e.stopPropagation(); // Prevent segment selection when clicking button
            toggleHighlight(index);
        };
        if (segment.is_highlighted) {
            highlightButton.classList.add('is-highlighted');
        }

        // Append timestamps to the left side of meta
        segmentMeta.appendChild(timestamps);

        // Append GPT error icon if present (to the right side)
        if (segment.gpt_error) {
            const gptErrorSpan = document.createElement('span');
            gptErrorSpan.className = 'segment-gpt-error';
            gptErrorSpan.textContent = '⚠️';
            gptErrorSpan.title = `GPT Error: ${segment.gpt_error}`;
            segmentMetaRight.appendChild(gptErrorSpan);
        }
        // Do NOT append highlightButton here anymore
        // segmentMetaRight.appendChild(highlightButton); // MOVED

        // Append the right side container to the meta bar
        segmentMeta.appendChild(segmentMetaRight);

        // Create Native Controls Container (holds textarea and audio)
        const segmentControlsNative = document.createElement('div');
        segmentControlsNative.className = 'segment-controls-native';

        // Text Area
        const textArea = document.createElement('textarea');
        textArea.id = `text-${index}`;
        textArea.value = segment.current_text;
        textArea.setAttribute('aria-label', `Segment ${index + 1} text`);

        // MODIFIED: Use adjustTextAreaHeight on input
        textArea.addEventListener('input', (event) => {
            segmentData[index].current_text = event.target.value;
            updateComparisonPreview();
            // Adjust height while typing
            adjustTextAreaHeight(event.target); // Pass the textarea element
        });

        // Initial height adjustment
        // We need to temporarily add to DOM to calculate scrollHeight correctly
        segmentElement.appendChild(segmentMeta);
        segmentElement.appendChild(segmentControlsNative);
        segmentElement.appendChild(textArea);
        segmentsContainer.appendChild(segmentElement); // Add to DOM *before* measuring

        // MODIFIED: Call adjustTextAreaHeight after adding to DOM
        adjustTextAreaHeight(textArea);

        // Add focus listener to select segment
        segmentElement.addEventListener('focus', () => selectSegment(index, false)); // Select on focus, don't scroll unless necessary

         // Highlight if needed
        if (segment.is_highlighted) {
            segmentElement.classList.add('highlighted');
            highlightButton.classList.add('is-highlighted');
        }

        // Show GPT error if present
        if (segment.gpt_error) {
            const errorSpan = document.createElement('span');
            errorSpan.className = 'segment-gpt-error';
            errorSpan.textContent = `⚠️ AI Edit Error: ${segment.gpt_error}`;
            segmentElement.insertBefore(errorSpan, textArea);
        }

        // Append the audio element
        const audioElement = document.createElement('audio');
        audioElement.id = `audio-${index}`;
        audioElement.controls = true;
        audioElement.preload = 'auto'; // Important for preloaded blobs
        if (segment.blobUrl) {
            audioElement.src = segment.blobUrl;
        }
        segmentControlsNative.appendChild(audioElement);

        // Append the highlight button HERE
        segmentControlsNative.appendChild(highlightButton);
    });

    updateComparisonPreview();
    comparisonExpander.style.display = 'block'; // Show comparison

    // Select the first segment by default, but don't scroll initially if preloading
    selectSegment(0, false);

    // Set initial focus to the first textarea for keyboard navigation
    const firstTextArea = segmentsContainer.querySelector('.segment textarea');
}

// --- Highlight Logic ---
function toggleHighlight(index) {
    if (!segmentData[index]) return;

    // Toggle state
    segmentData[index].is_highlighted = !segmentData[index].is_highlighted;

    // Update UI
    const segmentElement = document.getElementById(`segment-${index}`);
    const highlightButton = segmentElement?.querySelector('.highlight-button');

    if (segmentElement && highlightButton) {
        segmentElement.classList.toggle('highlighted', segmentData[index].is_highlighted);
        highlightButton.classList.toggle('is-highlighted', segmentData[index].is_highlighted);
    }

    // Note: Comparison preview doesn't need update, but main export format does.
}

// --- Segment Selection & Navigation Logic ---
function selectSegment(index, scrollIntoView = true) {
    if (index < 0 || index >= segmentData.length || !segmentsContainer) return;

    // Deactivate previously active segment
    const previousActive = segmentsContainer.querySelector('.segment.active');
    if (previousActive) {
        previousActive.classList.remove('active');
        // Optional: Pause audio if it was playing in the previous segment
        const audio = previousActive.querySelector('audio');
        if (audio && !audio.paused) {
            audio.pause();
        }
    }

    // Activate the new segment
    const segmentElement = segmentsContainer.querySelector(`.segment[data-index="${index}"]`);
    if (segmentElement) {
        activeSegmentIndex = index;
        segmentElement.classList.add('active');
        // Focus the textarea within the activated segment for immediate editing
        const textarea = segmentElement.querySelector('textarea');
        if (textarea) {
            // textarea.focus(); // Focus can be disruptive, maybe only on keyboard nav?
        }
        if (scrollIntoView) {
            segmentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // console.log("Selected segment:", activeSegmentIndex);
}

function updateComparisonPreview() {
    if (!originalTextPreview || !editedTextPreview) return;

    let originalFullText = segmentData.map(seg => seg.original_text).join(" ");
    let editedFullText = segmentData.map(seg => seg.current_text).join(" ");

    originalTextPreview.value = originalFullText.replace(/\s+/g, ' ').trim();
    editedTextPreview.value = editedFullText.replace(/\s+/g, ' ').trim();
}

// --- Audio Handling (Simplified / Commented Out) ---

function parseTime(timeString) {
    if (typeof timeString !== 'string') {
        console.warn("parseTime received non-string input:", timeString);
        return 0;
    }
    const parts = timeString.split(/[:.]/); // Split by colon or period
    if (parts.length < 3) {
         console.warn("parseTime received invalid format string:", timeString);
         return 0;
    }
    const hours = parseInt(parts[0], 10) || 0;
    const minutes = parseInt(parts[1], 10) || 0;
    const seconds = parseFloat(`${parts[2]}.${parts[3] || '0'}`); // Re-join seconds and milliseconds
    if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) {
        console.warn("parseTime failed to parse components:", timeString, parts);
        return 0;
    }
    return (hours * 3600) + (minutes * 60) + seconds;
}

function formatTime(seconds) {
    // ---> REMOVE LOGGING HERE <--- //
    // console.log(`Formatting time for input: ${seconds} (Type: ${typeof seconds})`);

    if (isNaN(seconds) || seconds === undefined || seconds === null) {
        // console.warn("formatTime received invalid input:", seconds); // Keep warning low-key
        return '00:00.0';
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    const formattedTime = `${String(minutes).padStart(2, '0')}:${String(remainingSeconds.toFixed(1)).padStart(4, '0')}`;
    return formattedTime;
}

/* function handleAudioTimeUpdate() { ... } */
/* function handleDurationChange() { ... } */
/* function updateProgressBarUI(index, progressFraction = null) { ... } */
/* function handlePointerDown(event) { ... } */
/* function handlePointerMove(event) { ... } */
/* function handlePointerUp(event) { ... } */
/* function calculateSeekPosition(clientX, progressBarContainer) { ... } */
/* function playAudioSafely() { ... } */
/* function togglePlayPause(index) { ... } */
/* function playSegmentAudio(index) { ... } */
/* function handleAudioPlay() { ... } */
/* function handleAudioPause() { ... } */
/* function handleAudioEnded() { ... } */
/* function handleAudioError(e) { ... } */
/* function updatePlayPauseButtonUI(index) { ... } */

// --- Keyboard Navigation (Simplified) ---

function handleGlobalKeyDown(event) {
    if (segmentData.length === 0) return;

    const targetIsTextArea = event.target.tagName === 'TEXTAREA';
    const targetIsAudio = event.target.tagName === 'AUDIO'; // Ignore if focused on audio controls

    if (targetIsAudio) return; // Let browser handle audio shortcuts

    switch (event.key) {
        case 'ArrowUp':
            event.preventDefault();
            // selectSegment(activeSegmentIndex - 1);
            // Find previous segment and focus its textarea for seamless up/down nav
            const prevSegmentIndex = activeSegmentIndex - 1;
            if (prevSegmentIndex >= 0) {
                selectSegment(prevSegmentIndex);
                const prevSegment = segmentsContainer.querySelector(`.segment[data-index="${prevSegmentIndex}"] textarea`);
                if (prevSegment) prevSegment.focus();
            }
            break;
        case 'ArrowDown':
            event.preventDefault();
            // selectSegment(activeSegmentIndex + 1);
            // Find next segment and focus its textarea
            const nextSegmentIndex = activeSegmentIndex + 1;
            if (nextSegmentIndex < segmentData.length) {
                selectSegment(nextSegmentIndex);
                const nextSegment = segmentsContainer.querySelector(`.segment[data-index="${nextSegmentIndex}"] textarea`);
                if (nextSegment) nextSegment.focus();
            }
            break;
        case ' ': // Spacebar
             // Prevent page scroll if focus is on button or potentially textarea?
            if (document.activeElement.tagName === 'BUTTON' || document.activeElement.tagName === 'TEXTAREA') {
                // ... existing code ...
            }
            break;
    }
}

// --- Run Initialization ---
// Wait for the DOM to be fully loaded before running init
document.addEventListener('DOMContentLoaded', init);