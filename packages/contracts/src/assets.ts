export interface AssetManifest {
  schema_version: 1;
  assets: Array<{
    asset_id: string;
    kind: 'skill' | 'doc' | 'package' | 'config' | 'model' | 'other';
    name: string;
    version: string;
    source: string;
    description: string;
    files: Array<{ path: string; sha256: string; bytes: number }>;
    entrypoints: Array<{ kind: string; path: string; description: string }>;
    dependencies: string[];
    permissions: string[];
    created_at: string;
    updated_at: string;
  }>;
}
