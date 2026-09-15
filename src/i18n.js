// IF Imgen - UI strings (en / vi). Pure module: no DOM, no ST imports.
// Usage: setLang(settings.language) once, then t('key') at render time.

let current = 'en';

export const LANGS = [
    { id: 'en', label: 'EN', title: 'English' },
    { id: 'vi', label: 'VI', title: 'Tiếng Việt' },
];

/** Small inline SVG flags (emoji flags do not render on Windows). */
export const FLAGS = {
    en: '<svg class="ifimgen-flag" viewBox="0 0 60 36" aria-hidden="true"><rect width="60" height="36" fill="#012169"/><path d="M0 0l60 36M60 0L0 36" stroke="#fff" stroke-width="7"/><path d="M0 0l60 36M60 0L0 36" stroke="#C8102E" stroke-width="4"/><path d="M30 0v36M0 18h60" stroke="#fff" stroke-width="12"/><path d="M30 0v36M0 18h60" stroke="#C8102E" stroke-width="7"/></svg>',
    vi: '<svg class="ifimgen-flag" viewBox="0 0 60 36" aria-hidden="true"><rect width="60" height="36" fill="#DA251D"/><polygon fill="#FFFF00" points="30,7 33.2,15.4 42.3,15.6 35.1,21 37.7,29.7 30,24.6 22.3,29.7 24.9,21 17.7,15.6 26.8,15.4"/></svg>',
};

export function setLang(lang) { current = STRINGS[lang] ? lang : 'en'; }
export function getLang() { return current; }

/** Translate. Missing keys fall back to English, then to the key itself. */
export function t(key, vars) {
    let s = STRINGS[current]?.[key] ?? STRINGS.en[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
}

const en = {
    // ---- tabs
    tab_settings: 'Settings', tab_chars: 'Characters', tab_personas: 'Personas', tab_styles: 'Styles',
    tab_gallery: 'Gallery', tab_help: 'How to use', tab_generate: 'Generate',
    lang_title: 'Language',
    hdr_update: 'Update', hdr_update_title: 'A newer IF Image (v{v}) is on GitHub. Click to open. Update via Extensions → Manage extensions → Update.',
    btn_discord: 'Contact · Discord', btn_discord_title: 'Join the Discord server (diuenmii)',

    // ---- entity tabs
    hint_chars: 'Visual definitions written here are the ONLY source for the image prompt (nothing is read from the ST card). Bind = auto-load in a chat / card. Referenced in plan via $keyword.',
    hint_personas: 'Your visual persona definitions. Bind = auto-load in a chat / card / ST persona; the ST persona description itself is never used.',
    hint_styles: 'A style profile is a fixed prompt frame (tags / description / negative / LoRA). The one marked ★ Default is applied to every image; nothing in the chat triggers it.',
    btn_new: 'New', box_identity: 'Identity', lbl_name: 'Name', lbl_keyword: 'Keyword ($)', lbl_aliases: 'Aliases', ph_aliases: 'comma separated',
    box_fragments: 'Prompt fragments', lbl_tags: 'Tags (danbooru)', lbl_natural: 'Natural description', lbl_negative: 'Negative',
    lbl_details: 'Details ($kw.key)',
    ph_details: 'one per line, key: description\noutfit: white button-up shirt, black skirt\nback: a big tattoo on the left shoulder blade\nnsfw: small breasts, pierced navel',
    note_details: 'Suggested keys: {keys} (any key works, Vietnamese too: <code>trang phục:</code> becomes <code>$kw.trang_phuc</code>). The planner only sees the token list, e.g. <code>$yenka.back</code>, and drops a token into the scene when that part is visible; the stored text is inserted at compile time (or merged by the refine LLM).',
    lbl_loras: 'LoRA lines', ph_loras: '<lora:name:0.8> one per line', lbl_lorapos: 'LoRA position',
    box_bind: 'Bind — auto-load when opened',
    note_bind: 'Binding only links this entry to a chat / card / persona so it loads automatically. Nothing is read from the card itself.',
    lbl_this_chat: 'This chat', btn_bind_chat: 'Bind this chat', btn_unbind_chat: 'Unbind this chat',
    lbl_cards: 'Character cards', btn_add_card: 'Add card', lbl_st_personas: 'ST personas', btn_add_persona: 'Add persona',
    lbl_always: 'Always active (every chat)',
    btn_save: 'Save', btn_delete: 'Delete', btn_export_json: 'Export JSON', btn_import_json: 'Import JSON', opt_merge: 'merge', opt_replace: 'replace',
    box_style_profile: 'Style profile', ph_style_name: 'e.g. Krea Niji',
    note_style: 'Tags are used when Dialect = tags, Natural description when Dialect = natural (each falls back to the other). Refine mode hands the style line to the second LLM call.',
    btn_set_default: 'Set default', btn_default_on: 'Default ✓',
    st_saved_count: '{n} saved', st_none: 'none', st_no_chat: 'No chat open.', st_bound_to: 'Bound to', st_not_bound_to: 'Not bound to',
    st_all_cards: '-- all cards bound / none --', st_none_opt: '-- none --',

    // ---- settings
    box_api: '1 · Image API', lbl_url: 'URL', lbl_auth: 'Auth user:pass',
    note_sd: "A1111-compatible endpoint (Comfy proxy / Forge / WebUI). Requests go through SillyTavern's /api/sd proxy, so no CORS needed.",
    lbl_nai_key: 'API key (pst-…)', lbl_variety: 'Variety+',
    btn_set_active: 'Set active', st_active: 'Active', btn_test: 'Test',
    box_model: '2 · Model', btn_fetch_models: 'Fetch models', st_fetch_first: '-- Fetch models first --', st_no_profile: '(no profile)',
    lbl_sampler: 'Sampler', lbl_scheduler: 'Scheduler', lbl_steps: 'Steps', lbl_cfg: 'CFG', lbl_width: 'Width', lbl_height: 'Height',
    btn_save_profile: 'Save profile', chip_default: 'default', chip_profile_saved: 'profile saved', chip_fallback: 'using fallback params',
    note_model: 'Each model keeps its own sampler/steps/CFG/size profile. ★ = default model used for generation.',
    box_llm: '3 · LLM (planner)', lbl_source: 'Source', opt_st_profile: 'SillyTavern connection profile', opt_custom: 'Custom OpenAI-compatible',
    lbl_profile: 'Profile', st_no_profiles: '-- no connection profiles --', lbl_base_url: 'Base URL', lbl_api_key: 'API key', lbl_model: 'Model', lbl_max_tokens: 'Max tokens',
    btn_test_llm: 'Test LLM',

    // ---- generate
    box_behaviour: 'Behaviour', lbl_enabled: 'Extension enabled', lbl_auto: 'Auto-generate on every character reply',
    lbl_show_button: 'Show per-message button', lbl_collapse: 'Collapse images in chat behind a small button',
    lbl_align: 'Image alignment in chat', opt_align_left: 'Left', opt_align_center: 'Center', opt_align_right: 'Right',
    lbl_count: 'Images per response', lbl_ctx: 'Context messages', lbl_minchars: 'Min paragraph chars', lbl_dialect: 'Prompt dialect',
    opt_tags: 'Tags (danbooru)', opt_natural: 'Natural language',
    note_behaviour: 'The planner reads the reply as numbered paragraphs and places each image right after the paragraph it illustrates.',
    box_calls: 'LLM calls per image', lbl_mode: 'Mode',
    opt_mode_plan: '1 call: planner only (tokens expanded verbatim; good for danbooru-tag models)',
    opt_mode_refine: '2 calls: planner + refine (second LLM rewrites cast details + scene into one prompt; good for natural-language models)',
    lbl_refine_system: 'Refine system prompt', btn_reset_default: 'Reset to default',
    note_refine: 'Placeholder: {{dialect_rule}}. Quality prefix, style fragment and LoRAs are still added by the compiler; the refine step only merges characters/personas with the scene.',
    box_preset: 'Planner preset', btn_save_as: 'Save as…', btn_delete_preset: 'Delete preset', btn_export_presets: 'Export presets', btn_import_presets: 'Import presets',
    note_preset: 'Built-in (★) presets are read-only — use “Save as…” to fork. Placeholders: {{count}}, {{dialect_rule}}.',
    box_frame: 'Prompt frame', lbl_quality: 'Quality prefix',
    note_negative: 'Untick Negative for models that ignore it (e.g. Krea); entity negatives are skipped as well.',
    h_overrides: 'Overrides (0 = use model profile)',
    box_preview: 'Prompt preview & test',
    ph_preview: "$rosario sews a wound on $yenka's side, dim bedroom, lamp light",
    btn_compile: 'Compile',
    note_preview: 'Write a scene like the planner would, then Compile. Key = which characters / personas / style were attached. Prompt 1-call = tokens expanded verbatim. Prompt 2-call = merged by the refine LLM (costs one LLM call). Edit either prompt and press Generate to render a test image — test images are kept in Gallery → Test images.',
    pv_key: 'Key', pv_p1: 'Prompt · 1 call (plan)', pv_p2: 'Prompt · 2 calls (refine)', btn_gen_test: 'Generate test',
    pv_compiling: 'Compiling…', pv_compiling_llm: 'Compiling (asking the refine LLM)…',
    pv_chars: 'characters', pv_personas: 'personas', pv_style: 'style', pv_unresolved: 'unresolved tokens', pv_expanded: 'EXPANDED SCENE', pv_negative: 'NEGATIVE', pv_disabled: '(disabled / empty)',
    btn_run_last: 'Generate for last reply', btn_regen_last: 'Regen last reply images',
    tip_regen_last: 'Re-render every image of the last character reply with the same scene and position (no new planning). Use this when the pictures are not to your liking.',
    st_no_char_msg: 'No character message.', st_no_images: 'The last reply has no IF Imgen images yet.', st_regen: 'regenerating', st_done: 'Done.', st_skipped: 'Skipped',
    st_rendering_test: 'Rendering test image…', st_test_done: 'Test image saved — see Gallery → Test images.',

    // ---- gallery
    box_gallery: 'Gallery — current chat', btn_refresh: 'Refresh',
    note_gallery: 'Click a thumbnail (or an image in chat) to view, regenerate, edit its prompt, or delete it.',
    st_gallery_count: '{n} image(s) in {chat}', st_gallery_empty: 'No IF Imgen images in {chat} yet.', st_this_chat: 'this chat',
    box_test_images: 'Test images', note_test_images: 'Images rendered from Prompt preview. Not part of any chat. Click to view, regenerate or delete.',
    st_test_empty: 'No test images yet.', st_test_count: '{n} test image(s)',
    vw_test: 'test image', vw_message: 'message', vw_scene: 'scene', vw_refined: 'refined', vw_final: 'final prompt', vw_no_prompt: 'no stored prompt (legacy image) — use Edit & regenerate',
    vw_regen: 'Regenerate', vw_edit: 'Edit & regenerate', vw_delete: 'Delete image', vw_jump: 'Go to message', vw_open: 'Open file', vw_close: 'Close', vw_prev: 'Previous', vw_next: 'Next',
    vw_edit_prompt_scene: 'Scene prompt (entities, style and quality/negative are re-applied on top):',
    vw_edit_prompt_final: 'Final prompt (sent to the image backend as-is):',
    vw_confirm_delete: 'Remove this image?', vw_regenerated: 'Regenerated.',

    // ---- chat
    chat_fold_btn: 'Image', chat_fold_title: 'IF Imgen image — click to show / hide',

    // ---- help
    help_title: 'How to use IF Imgen — step by step',
    help_intro: 'IF Imgen never reads the SillyTavern character card. Everything the image model sees comes from the entities you define here plus the scene the planner LLM writes from the chat text.',
    help_steps: [
        ['Connect the image API', 'Settings → <b>1 · Image API</b>. Pick <i>Comfy / A1111</i> (enter the A1111-compatible URL of your proxy / Forge / WebUI, optional user:pass) or <i>NovelAI</i> (API key). Press <b>Test</b>, then <b>Set active</b>.'],
        ['Pick a model and save its profile', 'Settings → <b>2 · Model</b>. <b>Fetch models</b>, select one, set sampler / steps / CFG / size, press <b>Save profile</b> and <b>Set default</b> (★).'],
        ['Choose the planner LLM', 'Settings → <b>3 · LLM</b>. Use a SillyTavern connection profile or a custom OpenAI-compatible endpoint. Press <b>Test LLM</b> — it should reply “OK”. The LLM receives only the reply paragraphs and your entity roster, never the card.'],
        ['Define characters and personas', 'Tab <b>Characters</b> / <b>Personas</b> → <b>New</b>. Give a Name and a Keyword (e.g. <code>lyna</code> → <code>$lyna</code>), write danbooru Tags and/or a Natural description, optional Negative and LoRA lines. In <b>Details</b> add one line per part, <code>outfit: …</code>, <code>back: …</code>; the planner can reference them as <code>$lyna.outfit</code>.'],
        ['Bind them so they load automatically', 'Same tab, box <b>Bind</b>: <i>Bind this chat</i>, add Character cards or ST personas, or tick <i>Always active</i>. Press <b>Save</b>. Only identifiers are used for binding; card text is never read.'],
        ['(Optional) Create a style', 'Tab <b>Styles</b> → New → tags / description / negative / LoRA → <b>Save</b> → <b>Set default</b>. The default style is applied to every image.'],
        ['Configure generation', 'Tab <b>Generate</b>: turn <i>Auto-generate</i> on or off, set images per response and context messages, choose the prompt dialect (tags vs natural), and the mode — <i>1 call</i> (planner only) or <i>2 calls</i> (planner + refine LLM). Quality prefix and Negative live in <b>Prompt frame</b>.'],
        ['Chat', 'When a character replies, the planner picks paragraphs and images are inserted right after them. The per-message button (🖼) generates for that message again; Shift+click removes its images. Slash command: <code>/ifimgen count=2</code>.'],
        ['Fix a picture you do not like', 'Click the image in chat (or a thumbnail in <b>Gallery</b>) → <b>Regenerate</b> (same scene), <b>Edit & regenerate</b> (change the scene), or <b>Delete</b>. <b>Generate → Regen last reply images</b> re-renders every image of the last reply at once.'],
        ['Test prompts and styles', '<b>Generate → Prompt preview & test</b>: type a scene with $keywords, press <b>Compile</b>. You get the Key (what was attached), the 1-call prompt and the 2-call prompt. Edit a prompt and press <b>Generate test</b>; results appear under <b>Gallery → Test images</b>.'],
    ],
    help_tips_title: 'Tips',
    help_tips: [
        'If your Comfy proxy adds character supplements, it can read <code>ifimgen_raw: true</code> in the request body and forward the prompt untouched.',
        'Models that ignore negative prompts (e.g. Krea): untick <i>Negative</i> in Prompt frame.',
        'Use <i>Collapse images in chat</i> (Generate → Behaviour) to keep the chat compact — each image sits behind a small button.',
        'Export / Import JSON on every entity tab to move characters, personas and styles between installs.',
    ],
};

const vi = {
    // ---- tabs
    tab_settings: 'Cài đặt', tab_chars: 'Nhân vật', tab_personas: 'Persona', tab_styles: 'Style',
    tab_gallery: 'Thư viện', tab_help: 'Hướng dẫn', tab_generate: 'Tạo ảnh',
    lang_title: 'Ngôn ngữ',
    hdr_update: 'Update', hdr_update_title: 'Đã có IF Image mới (v{v}) trên GitHub. Bấm để mở. Cập nhật qua Extensions → Manage extensions → Update.',
    btn_discord: 'Liên hệ · Discord', btn_discord_title: 'Tham gia server Discord (diuenmii)',

    // ---- entity tabs
    hint_chars: 'Mô tả ngoại hình viết ở đây là nguồn DUY NHẤT cho prompt ảnh (không đọc gì từ card ST). Bind = tự nạp trong chat / card. Planner gọi bằng $keyword.',
    hint_personas: 'Mô tả ngoại hình persona của bạn. Bind = tự nạp trong chat / card / persona ST; phần mô tả persona của ST không bao giờ được dùng.',
    hint_styles: 'Style là khung prompt cố định (tags / mô tả / negative / LoRA). Style đánh ★ Mặc định được áp cho mọi ảnh; chat không kích hoạt style.',
    btn_new: 'Mới', box_identity: 'Định danh', lbl_name: 'Tên', lbl_keyword: 'Keyword ($)', lbl_aliases: 'Tên gọi khác', ph_aliases: 'cách nhau bằng dấu phẩy',
    box_fragments: 'Mảnh prompt', lbl_tags: 'Tags (danbooru)', lbl_natural: 'Mô tả tự nhiên', lbl_negative: 'Negative',
    lbl_details: 'Chi tiết ($kw.key)',
    ph_details: 'mỗi dòng một mục, key: mô tả\noutfit: áo sơ mi trắng, váy đen\nback: hình xăm lớn ở bả vai trái\nnsfw: ngực nhỏ, khuyên rốn',
    note_details: 'Key gợi ý: {keys} (key chữ thường bất kỳ đều được). Planner chỉ thấy danh sách token, ví dụ <code>$yenka.back</code>, và chèn token vào cảnh khi phần đó lộ ra; nội dung lưu sẵn được ghép vào lúc compile (hoặc do LLM refine hòa trộn).',
    lbl_loras: 'Dòng LoRA', ph_loras: '<lora:name:0.8> mỗi dòng một cái', lbl_lorapos: 'Vị trí LoRA',
    box_bind: 'Bind — tự nạp khi mở',
    note_bind: 'Bind chỉ gắn mục này với chat / card / persona để tự nạp. Không đọc gì từ card.',
    lbl_this_chat: 'Chat này', btn_bind_chat: 'Gắn chat này', btn_unbind_chat: 'Gỡ chat này',
    lbl_cards: 'Card nhân vật', btn_add_card: 'Thêm card', lbl_st_personas: 'Persona ST', btn_add_persona: 'Thêm persona',
    lbl_always: 'Luôn bật (mọi chat)',
    btn_save: 'Lưu', btn_delete: 'Xóa', btn_export_json: 'Xuất JSON', btn_import_json: 'Nhập JSON', opt_merge: 'gộp', opt_replace: 'thay thế',
    box_style_profile: 'Hồ sơ style', ph_style_name: 'vd. Krea Niji',
    note_style: 'Tags dùng khi Dialect = tags, Mô tả tự nhiên dùng khi Dialect = natural (thiếu cái nào thì dùng cái kia). Chế độ refine chuyển dòng style cho lần gọi LLM thứ hai.',
    btn_set_default: 'Đặt mặc định', btn_default_on: 'Mặc định ✓',
    st_saved_count: '{n} đã lưu', st_none: 'không có', st_no_chat: 'Chưa mở chat.', st_bound_to: 'Đã gắn', st_not_bound_to: 'Chưa gắn',
    st_all_cards: '-- đã gắn hết / không có --', st_none_opt: '-- không có --',

    // ---- settings
    box_api: '1 · API ảnh', lbl_url: 'URL', lbl_auth: 'Auth user:pass',
    note_sd: 'Endpoint tương thích A1111 (Comfy proxy / Forge / WebUI). Request đi qua proxy /api/sd của SillyTavern nên không cần CORS.',
    lbl_nai_key: 'API key (pst-…)', lbl_variety: 'Variety+',
    btn_set_active: 'Kích hoạt', st_active: 'Đang dùng', btn_test: 'Kiểm tra',
    box_model: '2 · Model', btn_fetch_models: 'Tải danh sách model', st_fetch_first: '-- Bấm tải model trước --', st_no_profile: '(chưa có profile)',
    lbl_sampler: 'Sampler', lbl_scheduler: 'Scheduler', lbl_steps: 'Steps', lbl_cfg: 'CFG', lbl_width: 'Rộng', lbl_height: 'Cao',
    btn_save_profile: 'Lưu profile', chip_default: 'mặc định', chip_profile_saved: 'đã có profile', chip_fallback: 'dùng thông số dự phòng',
    note_model: 'Mỗi model giữ riêng sampler/steps/CFG/kích cỡ. ★ = model mặc định dùng để tạo ảnh.',
    box_llm: '3 · LLM (planner)', lbl_source: 'Nguồn', opt_st_profile: 'Connection profile của SillyTavern', opt_custom: 'Tự nhập (OpenAI-compatible)',
    lbl_profile: 'Profile', st_no_profiles: '-- chưa có connection profile --', lbl_base_url: 'Base URL', lbl_api_key: 'API key', lbl_model: 'Model', lbl_max_tokens: 'Max tokens',
    btn_test_llm: 'Kiểm tra LLM',

    // ---- generate
    box_behaviour: 'Hành vi', lbl_enabled: 'Bật extension', lbl_auto: 'Tự tạo ảnh sau mỗi câu trả lời của nhân vật',
    lbl_show_button: 'Hiện nút trên từng tin nhắn', lbl_collapse: 'Thu gọn ảnh trong chat vào một nút nhỏ',
    lbl_align: 'Căn lề ảnh trong chat', opt_align_left: 'Trái', opt_align_center: 'Giữa', opt_align_right: 'Phải',
    lbl_count: 'Số ảnh mỗi câu trả lời', lbl_ctx: 'Số tin nhắn ngữ cảnh', lbl_minchars: 'Độ dài đoạn tối thiểu', lbl_dialect: 'Kiểu prompt',
    opt_tags: 'Tags (danbooru)', opt_natural: 'Ngôn ngữ tự nhiên',
    note_behaviour: 'Planner đọc câu trả lời theo từng đoạn có đánh số và chèn ảnh ngay sau đoạn mà nó minh họa.',
    box_calls: 'Số lần gọi LLM mỗi ảnh', lbl_mode: 'Chế độ',
    opt_mode_plan: '1 lần: chỉ planner (token ghép nguyên văn; hợp model tag danbooru)',
    opt_mode_refine: '2 lần: planner + refine (LLM thứ hai viết lại chi tiết nhân vật + cảnh thành một prompt; hợp model ngôn ngữ tự nhiên)',
    lbl_refine_system: 'System prompt refine', btn_reset_default: 'Khôi phục mặc định',
    note_refine: 'Placeholder: {{dialect_rule}}. Quality prefix, style và LoRA vẫn do compiler thêm; bước refine chỉ hòa trộn nhân vật/persona với cảnh.',
    box_preset: 'Preset planner', btn_save_as: 'Lưu thành…', btn_delete_preset: 'Xóa preset', btn_export_presets: 'Xuất preset', btn_import_presets: 'Nhập preset',
    note_preset: 'Preset có sẵn (★) chỉ đọc — dùng “Lưu thành…” để tạo bản riêng. Placeholder: {{count}}, {{dialect_rule}}.',
    box_frame: 'Khung prompt', lbl_quality: 'Quality prefix',
    note_negative: 'Bỏ tick Negative với model không dùng negative (vd. Krea); negative của nhân vật cũng sẽ bị bỏ.',
    h_overrides: 'Ghi đè (0 = dùng profile model)',
    box_preview: 'Xem trước & thử prompt',
    ph_preview: '$rosario khâu vết thương bên hông $yenka, phòng ngủ tối, ánh đèn bàn',
    btn_compile: 'Compile',
    note_preview: 'Viết một cảnh như planner sẽ viết rồi bấm Compile. Key = nhân vật / persona / style nào được gắn vào. Prompt 1 lần = token ghép nguyên văn. Prompt 2 lần = LLM refine hòa trộn (tốn một lần gọi LLM). Sửa prompt tùy ý rồi bấm Tạo thử để render ảnh test — ảnh test nằm ở Thư viện → Ảnh thử.',
    pv_key: 'Key', pv_p1: 'Prompt · 1 lần gọi (plan)', pv_p2: 'Prompt · 2 lần gọi (refine)', btn_gen_test: 'Tạo thử',
    pv_compiling: 'Đang compile…', pv_compiling_llm: 'Đang compile (gọi LLM refine)…',
    pv_chars: 'nhân vật', pv_personas: 'persona', pv_style: 'style', pv_unresolved: 'token không nhận ra', pv_expanded: 'CẢNH ĐÃ GHÉP', pv_negative: 'NEGATIVE', pv_disabled: '(tắt / trống)',
    btn_run_last: 'Tạo ảnh cho reply cuối', btn_regen_last: 'Regen ảnh reply cuối',
    tip_regen_last: 'Vẽ lại toàn bộ ảnh của câu trả lời cuối với cùng cảnh và vị trí (không plan lại). Dùng khi ảnh chưa vừa ý.',
    st_no_char_msg: 'Không có tin nhắn của nhân vật.', st_no_images: 'Reply cuối chưa có ảnh IF Imgen.', st_regen: 'đang vẽ lại', st_done: 'Xong.', st_skipped: 'Bỏ qua',
    st_rendering_test: 'Đang render ảnh thử…', st_test_done: 'Đã lưu ảnh thử — xem Thư viện → Ảnh thử.',

    // ---- gallery
    box_gallery: 'Thư viện — chat hiện tại', btn_refresh: 'Tải lại',
    note_gallery: 'Bấm vào ảnh nhỏ (hoặc ảnh trong chat) để xem, vẽ lại, sửa prompt hoặc xóa.',
    st_gallery_count: '{n} ảnh trong {chat}', st_gallery_empty: '{chat} chưa có ảnh IF Imgen.', st_this_chat: 'chat này',
    box_test_images: 'Ảnh thử', note_test_images: 'Ảnh render từ Xem trước prompt. Không thuộc chat nào. Bấm để xem, vẽ lại hoặc xóa.',
    st_test_empty: 'Chưa có ảnh thử.', st_test_count: '{n} ảnh thử',
    vw_test: 'ảnh thử', vw_message: 'tin nhắn', vw_scene: 'cảnh', vw_refined: 'refine', vw_final: 'prompt cuối', vw_no_prompt: 'không có prompt lưu (ảnh cũ) — dùng Sửa & vẽ lại',
    vw_regen: 'Vẽ lại', vw_edit: 'Sửa & vẽ lại', vw_delete: 'Xóa ảnh', vw_jump: 'Tới tin nhắn', vw_open: 'Mở file', vw_close: 'Đóng', vw_prev: 'Trước', vw_next: 'Sau',
    vw_edit_prompt_scene: 'Prompt cảnh (nhân vật, style và quality/negative sẽ được ghép lại lên trên):',
    vw_edit_prompt_final: 'Prompt cuối (gửi thẳng cho backend ảnh):',
    vw_confirm_delete: 'Xóa ảnh này?', vw_regenerated: 'Đã vẽ lại.',

    // ---- chat
    chat_fold_btn: 'Ảnh', chat_fold_title: 'Ảnh IF Imgen — bấm để hiện / ẩn',

    // ---- help
    help_title: 'Hướng dẫn sử dụng IF Imgen — từng bước',
    help_intro: 'IF Imgen không bao giờ đọc card nhân vật của SillyTavern. Mọi thứ model ảnh nhìn thấy đều đến từ các entity bạn định nghĩa ở đây cộng với cảnh mà LLM planner viết ra từ nội dung chat.',
    help_steps: [
        ['Kết nối API ảnh', 'Cài đặt → <b>1 · API ảnh</b>. Chọn <i>Comfy / A1111</i> (nhập URL tương thích A1111 của proxy / Forge / WebUI, user:pass nếu có) hoặc <i>NovelAI</i> (API key). Bấm <b>Kiểm tra</b>, rồi <b>Kích hoạt</b>.'],
        ['Chọn model và lưu profile', 'Cài đặt → <b>2 · Model</b>. <b>Tải danh sách model</b>, chọn một model, đặt sampler / steps / CFG / kích cỡ, bấm <b>Lưu profile</b> và <b>Đặt mặc định</b> (★).'],
        ['Chọn LLM planner', 'Cài đặt → <b>3 · LLM</b>. Dùng connection profile của SillyTavern hoặc endpoint OpenAI-compatible tự nhập. Bấm <b>Kiểm tra LLM</b> — phải trả lời “OK”. LLM chỉ nhận các đoạn của câu trả lời và danh sách entity, không nhận card.'],
        ['Định nghĩa nhân vật và persona', 'Tab <b>Nhân vật</b> / <b>Persona</b> → <b>Mới</b>. Đặt Tên và Keyword (vd. <code>lyna</code> → <code>$lyna</code>), viết Tags danbooru và/hoặc Mô tả tự nhiên, Negative và LoRA nếu cần. Ở <b>Chi tiết</b> viết mỗi dòng một phần, <code>outfit: …</code>, <code>back: …</code>; planner có thể gọi <code>$lyna.outfit</code>.'],
        ['Bind để tự nạp', 'Cùng tab, ô <b>Bind</b>: <i>Gắn chat này</i>, thêm Card nhân vật hoặc Persona ST, hoặc tick <i>Luôn bật</i>. Bấm <b>Lưu</b>. Bind chỉ dùng định danh; không đọc nội dung card.'],
        ['(Tùy chọn) Tạo style', 'Tab <b>Style</b> → Mới → tags / mô tả / negative / LoRA → <b>Lưu</b> → <b>Đặt mặc định</b>. Style mặc định áp cho mọi ảnh.'],
        ['Cấu hình tạo ảnh', 'Tab <b>Tạo ảnh</b>: bật/tắt <i>Tự tạo ảnh</i>, đặt số ảnh mỗi reply và số tin nhắn ngữ cảnh, chọn kiểu prompt (tags / tự nhiên) và chế độ — <i>1 lần</i> (chỉ planner) hoặc <i>2 lần</i> (planner + LLM refine). Quality prefix và Negative nằm ở <b>Khung prompt</b>.'],
        ['Chat', 'Khi nhân vật trả lời, planner chọn đoạn và ảnh được chèn ngay sau đoạn đó. Nút trên tin nhắn (🖼) tạo lại ảnh cho tin nhắn đó; Shift+bấm để xóa ảnh. Lệnh: <code>/ifimgen count=2</code>.'],
        ['Sửa ảnh chưa vừa ý', 'Bấm vào ảnh trong chat (hoặc ảnh nhỏ ở <b>Thư viện</b>) → <b>Vẽ lại</b> (cùng cảnh), <b>Sửa & vẽ lại</b> (đổi cảnh) hoặc <b>Xóa</b>. <b>Tạo ảnh → Regen ảnh reply cuối</b> vẽ lại toàn bộ ảnh của reply cuối một lượt.'],
        ['Thử prompt và style', '<b>Tạo ảnh → Xem trước & thử prompt</b>: gõ một cảnh có $keyword, bấm <b>Compile</b>. Bạn nhận được Key (đã gắn gì), prompt 1 lần và prompt 2 lần. Sửa prompt rồi bấm <b>Tạo thử</b>; kết quả nằm ở <b>Thư viện → Ảnh thử</b>.'],
    ],
    help_tips_title: 'Mẹo',
    help_tips: [
        'Nếu proxy Comfy của bạn tự thêm mô tả nhân vật, nó có thể đọc <code>ifimgen_raw: true</code> trong body request để chuyển prompt nguyên văn.',
        'Model không dùng negative (vd. Krea): bỏ tick <i>Negative</i> ở Khung prompt.',
        'Bật <i>Thu gọn ảnh trong chat</i> (Tạo ảnh → Hành vi) để chat gọn hơn — mỗi ảnh nằm sau một nút nhỏ.',
        'Dùng Xuất / Nhập JSON ở mỗi tab entity để chuyển nhân vật, persona, style giữa các máy.',
    ],
};

const STRINGS = { en, vi };
;
