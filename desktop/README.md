# Omni Speak Desktop

Native macOS Electron shell for OmniVoice.

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

At runtime, Magic Setup creates a Python environment under
`~/Library/Application Support/omni-speak/runtime`, downloads the OmniVoice
and Whisper checkpoints through Hugging Face, and starts the local service on
`127.0.0.1:8001`.
