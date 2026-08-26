# Omni Speak Desktop

Native macOS Electron shell for OmniVoice.

Studio supports up to four speakers. Select text and use `Command+1` through
`Command+4` to assign a speaker. Smart Chunking keeps paragraph and sentence
boundaries intact, while Auto silence padding adjusts pacing between chunks,
paragraphs, and speaker changes.

## Development

```bash
npm install
npm start
```

## Build

```bash
npm run dist
```

The arm64 app bundle is written to:

```text
/Users/alexcrearive/Documents/ChatGPT/OmniSpeakBuild/mac-arm64/Omni Speak.app
```

At runtime, Magic Setup checks for a compatible native Python. If none is
available, it downloads Python 3.12 arm64 through Astral uv. The managed Python,
virtual environment, and cache stay under
`~/Library/Application Support/omni-speak/runtime`; Magic Setup does not modify
the user's shell profile or Homebrew installation. It then downloads the
OmniVoice and Whisper checkpoints through Hugging Face and starts the local
service on `127.0.0.1:8001`.
