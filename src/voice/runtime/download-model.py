"""Install-time download only. Runtime never downloads or calls an inference API."""
import argparse
from huggingface_hub import snapshot_download

parser = argparse.ArgumentParser()
parser.add_argument('--model-dir', required=True)
parser.add_argument('--model', choices=['small', 'large-v3-turbo'], default='small')
args = parser.parse_args()
repo, revision = {
    'small': ('Systran/faster-whisper-small', '536b0662742c02347bc0e980a01041f333bce120'),
    'large-v3-turbo': ('mobiuslabsgmbh/faster-whisper-large-v3-turbo', '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf'),
}[args.model]
snapshot_download(repo,
                  revision=revision,
                  local_dir=args.model_dir,
                  allow_patterns=['config.json', 'preprocessor_config.json', 'model.bin', 'tokenizer.json', 'vocabulary.*'])
