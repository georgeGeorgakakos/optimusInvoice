import os
from huggingface_hub import hf_hub_download
dst = "/llama"
os.makedirs(dst, exist_ok=True)
p = hf_hub_download(
    repo_id="Qwen/Qwen2.5-3B-Instruct-GGUF",
    filename="qwen2.5-3b-instruct-q4_k_m.gguf",
    local_dir=dst,
)
print("Downloaded to:", p, flush=True)
