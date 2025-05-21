# backend/core_logic.py
import re
from io import BytesIO
import openai
import os
from pydub import AudioSegment
import logging
import mimetypes
import time
import math
from dotenv import load_dotenv

load_dotenv() # Load variables from .env

# Get the logger configured in main.py
logger = logging.getLogger(__name__)

# --- Configuration ---
HIGHLIGHT_MARKER = "[HIGHLIGHTED SEGMENT] "
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY") # Read from environment
DEFAULT_TARGET_WORD_COUNT = 60 # <--- MAKE SURE THIS LINE EXISTS

# --- GPT Function ---
def fix_segment_with_gpt(text_segment):
    if not OPENAI_API_KEY:
        logger.error("fix_segment_with_gpt called without API Key.") # Use logger
        # Return original text and an error flag/message instead of raising an exception
        # so the main process can continue but signal the failure.
        return text_segment, "OpenAI API Key missing"
    prompt = ("Professional transcription editor: Correct the following transcript segment. "
              "Fix typos and grammatical errors. "
              "You may slightly adjust sentence structure for better flow. "
              "If a word clearly doesn't fit the context, replace it with the most likely intended word. "
              "Preserve the original meaning as much as possible. Output ONLY the corrected text.\\n\\n" + text_segment)
    try:
        client = openai.OpenAI(api_key=OPENAI_API_KEY)
        response = client.chat.completions.create(
            model="gpt-4o", messages=[{"role": "user", "content": prompt}], temperature=0.2)
        reply = response.choices[0].message.content.strip()
        if not reply:
            logger.warning(f"GPT empty reply for: '{text_segment[:50]}...'.") # Use logger
            # Maybe return original + warning? Or just original?
            return text_segment, "GPT returned empty reply"
        logger.debug(f"GPT corrected: '{text_segment[:50]}...' -> '{reply[:50]}...'") # Use logger
        return reply, None # Return corrected text and no error
    except openai.AuthenticationError as e:
        logger.error(f"OpenAI Auth Error: {e}.") # Use logger
        return text_segment, "OpenAI Authentication Error"
    except Exception as e:
        logger.error(f"OpenAI API Error: {e}.") # Use logger
        return text_segment, f"OpenAI API Error: {e}"

def translate_segment_to_norwegian_with_gpt(text_segment: str):
    if not OPENAI_API_KEY:
        logger.error("translate_segment_to_norwegian_with_gpt called without API Key.")
        return text_segment, "OpenAI API Key missing"

    # Ensure the input text is not empty or just whitespace
    if not text_segment or text_segment.isspace():
        logger.info("translate_segment_to_norwegian_with_gpt received empty or whitespace input, returning as is.")
        return text_segment, None # Return original, no error

    prompt = (
        "Translate the following text accurately to Norwegian (Bokmål). "
        "Preserve the original meaning, tone, and context as much as possible. "
        "Output ONLY the translated Norwegian text.\n\n"
        "Text to translate:\n"
        f'"""{text_segment}"""'  # Use single quotes for the f-string part
    )
    try:
        client = openai.OpenAI(api_key=OPENAI_API_KEY)
        response = client.chat.completions.create(
            model="gpt-4o",  # Or your preferred model
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3  # Temperature can be adjusted for translation tasks
        )
        reply = response.choices[0].message.content.strip()
        if not reply:
            logger.warning(f"GPT empty reply for translation of: '{text_segment[:50]}...'.")
            return text_segment, "GPT returned empty reply for translation"
        logger.debug(f"GPT translated: '{text_segment[:50]}...' -> '{reply[:50]}...'")
        return reply, None  # Return translated text and no error
    except openai.AuthenticationError as e:
        logger.error(f"OpenAI Auth Error during translation: {e}.")
        return text_segment, "OpenAI Authentication Error during translation"
    except Exception as e:
        logger.error(f"OpenAI API Error during translation: {e}.")
        return text_segment, f"OpenAI API Error during translation: {e}"

# --- Cleaning Function ---
def clean_final_text(text):
    return re.sub(r'\s+', ' ', text).strip()

# --- Timestamp Parser ---
def parse_timestamped_transcript(text):
    # Keep logging, but don't use st.warning
    pattern = r"(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})\n(.*?)(?=\n\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->|\Z)"
    matches = re.findall(pattern, text, re.DOTALL); blocks = []
    for start, end, content in matches:
        content = re.sub(r"^\s*\d+\s*\n", "", content); start_norm = start.replace(",", "."); end_norm = end.replace(",", ".")
        text_clean = re.sub(r'\s+', ' ', content.strip())
        text_clean = re.sub(r"(?<!\S)\b\d+\b(?!\S)", "", text_clean).strip()
        text_clean = re.sub(r'\s{2,}', ' ', text_clean)
        if text_clean: blocks.append({"start": start_norm, "end": end_norm, "text": text_clean.strip()})
    logger.info(f"Parsed/cleaned {len(blocks)} non-empty blocks.") # Use logger
    if not blocks: logger.warning("No transcript blocks found after cleaning.") # Use logger
    return blocks

# --- Audio Utils ---
def get_audio_segment(full_audio: AudioSegment | None, start_str: str, end_str: str) -> AudioSegment | None:
    # Keep logging, function is fine
    if full_audio is None: return None
    try:
        start_ms=time_to_millis(start_str); end_ms=time_to_millis(end_str)
        start_ms=max(0, start_ms); end_ms=max(start_ms, end_ms); end_ms=min(end_ms, len(full_audio))
        return full_audio[start_ms:end_ms] if start_ms < end_ms else None
    except ValueError as e: logger.error(f"Timestamp conversion error: {e}"); return None # Use logger
    except Exception as e: logger.error(f"Audio slicing error: {e}"); return None # Use logger

def time_to_millis(ts_str: str) -> int:
    # Function is fine
    try:
        h, m, sec_ms = ts_str.split(':'); s, ms_str = sec_ms.split('.')
        ms = int(ms_str.ljust(3, '0')[:3]) if len(sec_ms)>1 and ms_str else 0
        return int(h)*3600000 + int(m)*60000 + int(s)*1000 + ms
    except Exception as e: raise ValueError(f"Invalid timestamp: '{ts_str}'") from e

def get_audio_format_from_upload(upload_file) -> str | None:
    # Use filename and content_type from UploadFile
    content_type = upload_file.content_type
    filename = upload_file.filename
    fmt = get_audio_format_from_mime(content_type) or \
          (os.path.splitext(filename)[1].lstrip('.') if filename else None)
    if not fmt:
        logger.warning(f"Could not determine audio format for {filename} (type: {content_type})") # Use logger
    return fmt

def get_audio_format_from_mime(mime: str | None) -> str | None:
    # Function is fine
    if not mime: return None
    mapping={"audio/mpeg":"mp3","audio/mp4":"m4a","audio/m4a":"m4a","audio/x-m4a":"m4a",
             "audio/wav":"wav","audio/x-wav":"wav","audio/ogg":"ogg","audio/aac":"aac"}
    fmt=mapping.get(mime) or (mimetypes.guess_extension(mime) or "").lstrip('.')
    if not fmt: fmt='m4a' if 'mp4' in mime else 'mp3' if 'mpeg' in mime else 'wav' if 'wav' in mime else None
    return fmt

# --- Grouping Function ---
def group_blocks_by_word_count(blocks, target_count=60):
    # Keep logging, function is fine
    grouped=[]; current_text=""; current_start=None; current_end=None; current_count=0
    if not blocks: return grouped
    for i, block in enumerate(blocks):
        txt=block['text']; wc=len(txt.split()); is_new = (current_count == 0)
        finalize = not is_new and (current_count >= target_count or (current_count + wc > target_count * 1.5 and current_count > 0))
        if finalize:
            # Store both original and potentially edited text from start
            grouped.append({"text": current_text.strip(), "original_text": current_text.strip(), "start": current_start, "end": current_end, "gpt_error": None}) # Add gpt_error field
            current_text=""; current_count=0; current_start=None; is_new=True
        if is_new: current_start=block['start']; current_text=txt
        else: current_text += " " + txt
        current_end=block['end']; current_count+=wc
        if i == len(blocks) - 1 and current_count > 0:
             grouped.append({"text": current_text.strip(), "original_text": current_text.strip(), "start": current_start, "end": current_end, "gpt_error": None}) # Add gpt_error field
    logger.info(f"Grouped into {len(grouped)} segments (~{target_count} words).") # Use logger
    return grouped