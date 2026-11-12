# PoVoxelStrike asset drop folder

Put `.glb` files here. On the next API start, the ingestion job converts each new file
into a voxel volume (identified by the SHA-256 of its bytes) under `../converted/`, and
it appears in the game world automatically.

- Renaming a file does not re-convert it (identity is the content hash). Editing it does.
- A broken GLB is logged and skipped; it never blocks startup.
- Fixed detail: the longest axis becomes 64 voxels (`PoVoxelStrike:VoxelResolution`).
- v1 samples material base-color factors only — textures are not sampled yet.

The `converted/` output is build product, not source — it is git-ignored.
