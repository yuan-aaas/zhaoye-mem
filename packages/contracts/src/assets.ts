import { z } from 'zod';

export const AssetIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const AssetPathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (path) =>
      path
        .split('/')
        .every(
          (segment) =>
            segment.length > 0 &&
            segment !== '.' &&
            segment !== '..' &&
            !/[<>:"\\|?*]/u.test(segment) &&
            !Array.from(segment).some((char) => char.charCodeAt(0) < 32) &&
            !/[. ]$/.test(segment) &&
            !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment),
        ),
    'asset path must be portable and relative',
  );

const AssetFileSchema = z.strictObject({
  path: AssetPathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
});
const AssetRecordSchema = z
  .strictObject({
    asset_id: AssetIdSchema,
    kind: z.enum(['skill', 'doc', 'package', 'config', 'model', 'other']),
    name: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(100),
    source: z.string().min(1).max(500),
    description: z.string().max(1000),
    files: z.array(AssetFileSchema).max(10000),
    entrypoints: z.array(
      z.strictObject({
        kind: z.string().min(1).max(64),
        path: AssetPathSchema,
        description: z.string().max(300),
      }),
    ),
    dependencies: z.array(z.string()),
    permissions: z.array(z.string()),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .refine(({ files, entrypoints }) => {
    const exact = new Set(files.map(({ path }) => path));
    const portable = new Set(files.map(({ path }) => path.normalize('NFC').toLowerCase()));
    return portable.size === files.length && entrypoints.every(({ path }) => exact.has(path));
  }, 'file paths must be unique and entrypoints must refer to catalogued files');

export const AssetManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  assets: z
    .array(AssetRecordSchema)
    .refine(
      (assets) => new Set(assets.map((asset) => asset.asset_id)).size === assets.length,
      'duplicate asset ID',
    ),
});

export const ConfigBundleManifestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(100),
  description: z.string().max(1000),
  modules: z.record(z.string(), z.object({ path: z.string() })),
});

export type AssetManifest = z.infer<typeof AssetManifestSchema>;
export type AssetRecord = z.infer<typeof AssetRecordSchema>;
export type AssetFile = z.infer<typeof AssetFileSchema>;

const writeTarget = {
  path: AssetPathSchema,
};
const expectedSha = z.string().regex(/^[a-f0-9]{64}$/);
const content = z
  .string()
  .max(6000)
  .refine((value) => !value.includes('\0'));
export const ConfigBundleWriteSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), ...writeTarget }),
  z.strictObject({ action: z.literal('update'), ...writeTarget, sha256: expectedSha, content }),
  z.strictObject({ action: z.literal('delete'), ...writeTarget, sha256: expectedSha }),
  z.strictObject({
    action: z.literal('archive'),
    ...writeTarget,
    report_type: z.enum(['daily', 'weekly', 'monthly']),
    content,
  }),
]);
export type ConfigBundleWrite = z.infer<typeof ConfigBundleWriteSchema>;

export interface AssetStore {
  scan(): Promise<AssetManifest>;
  resolveAsset(assetId: string): Promise<AssetRecord>;
  readFile(assetId: string, path: string): Promise<{ file: AssetFile; content: string }>;
  readBytes(
    assetId: string,
    path: string,
    offset: number,
    length: number,
  ): Promise<{ file: AssetFile; base64: string; next_offset: number | null }>;
  verify(assetId: string): Promise<{ asset_id: string; files: number; verified: true }>;
  initialize(): Promise<{ created: boolean }>;
  registerConfigBundle(assetId: string): Promise<AssetRecord>;
  writeConfigBundle(
    assetId: string,
    operation: ConfigBundleWrite,
    python: string,
  ): Promise<{ asset_id: string; action: ConfigBundleWrite['action']; path: string }>;
}
