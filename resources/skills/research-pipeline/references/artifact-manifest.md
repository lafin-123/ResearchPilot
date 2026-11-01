# Artifact Manifest

Keep one machine-readable manifest per pipeline (exports/artifact-manifest.json):

- project id;
- stage statuses;
- research brief path;
- experiment IDs and run IDs;
- analysis path;
- figure IDs and source run IDs;
- manuscript document IDs;
- unresolved TODOs and unverified claims.

Update it at every stage boundary. Scripts and the UI can use it to detect missing artifacts.
