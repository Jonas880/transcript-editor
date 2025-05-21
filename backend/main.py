# backend/main.py
import os
import uuid
import logging
from io import BytesIO
from pathlib import Path

import aiofiles
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, BackgroundTasks, Response, Request
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydub import AudioSegment

# Import functions from core_logic
from core_logic import (
    parse_timestamped_transcript,
    get_audio_format_from_upload,
    group_blocks_by_word_count,
    fix_segment_with_gpt,
    translate_segment_to_norwegian_with_gpt,
    get_audio_segment,
    time_to_millis, # Needed for audio slicing
    HIGHLIGHT_MARKER, # Might be needed if backend adds markers later
    clean_final_text, # Might be needed for preview/final generation later
    DEFAULT_TARGET_WORD_COUNT # <---- UNCOMMENT THIS LINE
)

# --- Setup Logging & Temp Directory ---
logging.basicConfig(level=logging.DEBUG, format='%(asctime)s - %(levelname)s - %(message)s')
TEMP_DIR = Path("./temp_audio")
TEMP_DIR.mkdir(exist_ok=True)

# --- In-Memory Storage (Replace with DB/Redis for production) ---
# Stores session data: { session_id: {"audio_path": str, "audio_format": str, "segments": list[dict]} }
session_data = {}

# --- FastAPI App ---
app = FastAPI()

# --- CORS Middleware (Allow Frontend Requests) ---
# Adjust origins as needed for deployment
origins = [
    "http://localhost",
    "http://127.0.0.1",
    "http://localhost:5001",  # Allow backend origin itself if needed
    "http://127.0.0.1:5001",
    "http://localhost:8000",  # Keep frontend origin (in case it works later)
    "http://127.0.0.1:8000",
    "http://localhost:8001",  # <--- ADD THIS LINE for your frontend
    "http://127.0.0.1:8001", # <--- ADD THIS LINE for your frontend (alternative)
    "http://localhost:8080",  # Add frontend origin (browser reports this)
    "http://127.0.0.1:8080", # Add frontend origin (alternative)
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Helper: Cleanup Task ---
def remove_temp_file(file_path: Path):
    try:
        if file_path.exists():
            file_path.unlink()
            logging.info(f"Removed temporary file: {file_path}")
    except Exception as e:
        logging.error(f"Error removing temp file {file_path}: {e}")

# --- API Endpoints ---

@app.post("/api/process")
async def process_files(
    request: Request,
    background_tasks: BackgroundTasks,
    transcript_file: UploadFile = File(...),
    audio_file: UploadFile = File(...),
    target_words: int = Form(DEFAULT_TARGET_WORD_COUNT),
    fix_typos: bool = Form(False),
    translate_norwegian: bool = Form(False)
):
    logging.info(f"--- ENTERING /api/process ---")
    logging.info(f"Request Headers: {dict(request.headers)}")
    session_id = str(uuid.uuid4())
    logging.info(f"Processing request for session {session_id}")
    audio_path = None # Define audio_path before try block

    try:
        # 1. Read Transcript
        transcript_content = await transcript_file.read()
        transcript_text = transcript_content.decode("utf-8")
        logging.info(f"Read transcript file: {transcript_file.filename}")

        # 2. Save Audio Temporarily
        audio_format = get_audio_format_from_upload(audio_file)
        if not audio_format:
            raise HTTPException(status_code=400, detail="Could not determine audio format.")

        audio_filename = f"{session_id}.{audio_format}"
        audio_path = TEMP_DIR / audio_filename
        async with aiofiles.open(audio_path, 'wb') as out_file:
            content = await audio_file.read()
            await out_file.write(content)
        logging.info(f"Saved temporary audio: {audio_path}")

        # 3. Parse Transcript
        blocks = parse_timestamped_transcript(transcript_text)
        if not blocks:
            raise HTTPException(status_code=400, detail="No valid transcript blocks found.")

        # 4. Group Blocks
        grouped_segments = group_blocks_by_word_count(blocks, target_count=target_words)
        if not grouped_segments:
            raise HTTPException(status_code=400, detail="Failed to group transcript blocks.")

        # 5a. Optional: Fix Typos with GPT
        gpt_editor_status = "None"
        if fix_typos:
            gpt_editor_status = "GPT-4o (Per Segment)"
            logging.info(f"[{session_id}] Starting GPT correction for {len(grouped_segments)} segments.")
            for i, seg in enumerate(grouped_segments):
                corrected_text, gpt_error = fix_segment_with_gpt(seg['text'])
                seg['text'] = corrected_text
                seg['gpt_error'] = gpt_error
                if gpt_error:
                    logging.warning(f"[{session_id}] GPT error on seg {i}: {gpt_error}")
            logging.info(f"[{session_id}] GPT correction finished.")
        else:
             for seg in grouped_segments: seg['gpt_error'] = None

        # 5b. Optional: Translate to Norwegian with GPT
        if translate_norwegian:
            if gpt_editor_status == "None": # Update editor status if not already set
                gpt_editor_status = "GPT-4o (Translation)"
            else:
                gpt_editor_status += " + Translation" # Append if typos were also fixed

            logging.info(f"[{session_id}] Starting Norwegian translation for {len(grouped_segments)} segments.")
            for i, seg in enumerate(grouped_segments):
                # Translate the current text (which might have been typo-corrected)
                translated_text, translate_error = translate_segment_to_norwegian_with_gpt(seg['text'])
                seg['text'] = translated_text  # Update text with translated version
                
                # Append translation error to existing gpt_error, or create if None
                if translate_error:
                    current_error = seg.get('gpt_error')
                    new_error_msg = f"TranslateError: {translate_error}"
                    if current_error:
                        seg['gpt_error'] = f"{current_error}; {new_error_msg}"
                    else:
                        seg['gpt_error'] = new_error_msg
                    logging.warning(f"[{session_id}] Translation error on seg {i}: {translate_error}")
            logging.info(f"[{session_id}] Norwegian translation finished.")

        # 6. Store Session Data (In-Memory)
        session_data[session_id] = {
            "audio_path": str(audio_path),
            "audio_format": audio_format,
            "segments": grouped_segments
        }
        logging.info(f"Stored data for session {session_id}")

        # 7. Return Session ID and Initial Segments
        return JSONResponse(content={
            "session_id": session_id,
            "segments": grouped_segments, # Send initial data to frontend
            "editor_status": gpt_editor_status,
            "target_words": target_words
        })

    except HTTPException as e:
         # If an error occurred after saving audio, attempt cleanup
        if audio_path and audio_path.exists():
            remove_temp_file(audio_path) # Clean up immediately on error
        logging.error(f"HTTPException during processing: {e.detail}")
        raise e # Re-raise the exception
    except Exception as e:
        if audio_path and audio_path.exists():
            remove_temp_file(audio_path) # Clean up immediately on error
        logging.error(f"Unexpected error during processing: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {e}")


@app.get("/api/audio/{session_id}/{segment_index}")
async def get_segment_audio(request: Request, session_id: str, segment_index: int):
    logging.info(f"Request for audio: session={session_id}, segment={segment_index}")
    # 1. Retrieve Session Data
    session = session_data.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")

    audio_path = session.get("audio_path")
    audio_format = session.get("audio_format")
    segments = session.get("segments")

    if not audio_path or not Path(audio_path).exists():
        raise HTTPException(status_code=404, detail="Audio file not found for this session.")
    if not segments or segment_index < 0 or segment_index >= len(segments):
        raise HTTPException(status_code=404, detail="Segment index out of bounds.")

    # 2. Load Full Audio (Consider caching this if accessed frequently)
    try:
        full_audio = AudioSegment.from_file(audio_path, format=audio_format)
    except Exception as e:
        logging.error(f"Error loading audio file {audio_path}: {e}")
        raise HTTPException(status_code=500, detail="Error loading audio.")

    # 3. Get Segment Timestamps
    segment_info = segments[segment_index]
    start_ts = segment_info.get("start")
    end_ts = segment_info.get("end")
    if not start_ts or not end_ts:
         raise HTTPException(status_code=404, detail="Segment timestamp data missing.")

    # 4. Slice Audio
    audio_clip = get_audio_segment(full_audio, start_ts, end_ts)
    if audio_clip is None or len(audio_clip) == 0:
        # Return empty response or a specific status? Let's return 204 No Content
        logging.warning(f"Empty audio clip generated for seg {segment_index}, session {session_id}")
        # Return an empty MP3 or WAV? Or just 204? Frontend needs to handle this.
        # Returning empty content might be cleaner.
        return Response(status_code=204)


    # 5. Export Slice to Bytes (Try MP3, fallback to WAV)
    audio_bytes_io = BytesIO()
    export_format = "mp3"
    content_type = "audio/mpeg"
    try:
        audio_clip.export(audio_bytes_io, format=export_format)
        logging.debug(f"Exported seg {segment_index} as MP3")
    except Exception as export_mp3_err:
        logging.warning(f"MP3 export failed for seg {segment_index} ({export_mp3_err}), trying WAV...")
        export_format = "wav"
        content_type = "audio/wav"
        audio_bytes_io = BytesIO() # Reset buffer
        try:
            audio_clip.export(audio_bytes_io, format=export_format)
            logging.debug(f"Exported seg {segment_index} as WAV")
        except Exception as export_wav_err:
            logging.error(f"WAV export failed for seg {segment_index}: {export_wav_err}")
            raise HTTPException(status_code=500, detail="Failed to export audio segment.")

    # 6. Handle Range Requests for Seeking
    audio_bytes = audio_bytes_io.getvalue()
    total_size = len(audio_bytes)
    range_header = request.headers.get('range')
    status_code = 200 # Default to OK
    headers = {
        'Content-Type': content_type,
        'Accept-Ranges': 'bytes', # Signal that we accept range requests
        'Content-Length': str(total_size)
    }

    start, end = 0, total_size - 1 # Default: serve the whole file

    if range_header:
        logging.debug(f"Range header detected: {range_header}")
        try:
            # Expected format: "bytes=start-end" or "bytes=start-"
            range_value = range_header.strip().split('=')[1]
            start_str, end_str = range_value.split('-')
            start = int(start_str)
            if end_str: # If end is specified
                 end = int(end_str)
            else: # If only start is specified ("bytes=100-")
                end = total_size - 1
            # Clamp values to valid range
            start = max(0, start)
            end = min(end, total_size - 1)

            if start >= total_size or start > end:
                # Requested range is invalid
                logging.warning(f"Invalid range requested: {range_header}, size: {total_size}")
                return Response(status_code=416) # Range Not Satisfiable

            status_code = 206 # Partial Content
            headers['Content-Range'] = f'bytes {start}-{end}/{total_size}'
            headers['Content-Length'] = str(end - start + 1)
            logging.debug(f"Serving range: bytes {start}-{end}/{total_size}")
        except Exception as e:
            logging.error(f"Error parsing Range header '{range_header}': {e}")
            # Fallback to sending the whole file if parsing fails
            status_code = 200
            start, end = 0, total_size - 1
            headers['Content-Length'] = str(total_size)
            if 'Content-Range' in headers: del headers['Content-Range']

    # Create a BytesIO object for the specific chunk
    chunk_io = BytesIO(audio_bytes[start:end + 1])

    return StreamingResponse(
        chunk_io,
        status_code=status_code,
        headers=headers,
        media_type=content_type # Redundant if Content-Type in headers, but safe
    )


# Add a simple root endpoint for testing
@app.get("/")
def read_root():
    return {"message": "Transcript Editor Backend"}

# --- To Run (in backend/ directory) ---
# uvicorn main:app --reload --port 5001
# (Run on a different port than the frontend, e.g., 5001)