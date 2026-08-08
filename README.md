# AI競馬予想・収益検証 MVP

合意済み仕様を反映した、個人用Webアプリの静的プロトタイプとSupabaseスキーマです。

## 収録物

- `index.html` / `styles.css` / `app.js`: 主要画面を確認できる依存なしプロトタイプ
- `supabase/schema.sql`: RLSを含むMVPデータベース設計
- `supabase/functions/_shared/nar-csv-provider.ts`: 地方競馬公式CSV用プロバイダー
- `supabase/functions/_shared/ai-contracts.ts`: AI出力の厳格な検証
- `supabase/functions/weekend-daily/index.ts`: 認証・冪等性を備えた土日バッチ骨格
- `docs/architecture.md`: 土日07:00のバッチ、Gemini 4リクエスト、セキュリティ設計

## プロトタイプ確認

`index.html` をブラウザで開いてください。表示データは画面確認用のサンプルです。

## 次の実装工程

1. Geminiによるレース選定（1回）と3戦略の予想（各1回）を実装する。
2. Supabaseプロジェクトを作成し、CLIで正式なmigrationを生成する。
3. 検証済みパーサーに対してGemini選定・3戦略予想・精算処理を有効化する。
4. フロントをSupabase Auth/Data APIへ接続する。
5. Cloudflare PagesをGitHub連携し、静的成果物を配信する。

APIキーやsecret keyはリポジトリへ保存しません。
