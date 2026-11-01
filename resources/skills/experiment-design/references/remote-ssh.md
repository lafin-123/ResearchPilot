# Remote SSH Experiments

Before running:

- confirm the remote Python environment and dependencies;
- confirm the workspace path and disk space;
- confirm GPU availability if relevant;
- confirm the command and time limit;
- confirm what artifacts will be downloaded.

The bridge uploads the experiment folder, runs the command, and downloads the run directory. Keep the local code as the source of truth. Large datasets should be referenced by path, not copied blindly.

Report the remote host, Python version, hardware, and any environment differences.

Use explicit approval for remote commands and long runs. Do not assume a remote path exists or that a GPU is free.
