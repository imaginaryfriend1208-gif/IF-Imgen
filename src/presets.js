// IF Imgen - prompt translator presets (step 2: scene document -> image prompts), builtin + user. Pure module.
import { uuid } from './util.js';

const OUTPUT_RULES = `

WHAT YOU WRITE: an image prompt is a description of the SCENE in that paragraph -- who is present, what each person is doing, pose, expression, clothing state, where they are, lighting, camera angle/shot type. It is NOT a character sheet. You never retell or continue the story and you never output anything except the requested JSON.

CAST: the ROSTER lists known people as $keyword with their base look, their stored DETAILS ($seb.back: ...) and their WORLD entries ($seb.apartment: ..., $seb.npc_william: ... - places, side characters and recurring items of that person's story). The SCENE DOCUMENT may open with a TOKENS section that defines extra tokens for this reply ($seb.outfit_work: ...). Mention each person present by their $keyword; a paragraph with two people names both. If nobody from the roster is in the paragraph, describe the person generically (a young woman with short brown hair...) without any $keyword. CONFIDENCE: use a $keyword only when you are at least 70% sure the text means that person; otherwise describe generically instead of guessing.

TOKENS IN THE PROMPT: when a stored entry or a TOKENS definition IS what is on show, worn, present or where the scene happens, write the TOKEN in "prompt" (e.g. "$seb sits on $seb.sofa wearing $seb.outfit_work, $seb.npc_william stands in the doorway") and add only what differs right now (unbuttoned, soaked, torn). Never write a token that is not listed in the ROSTER or the TOKENS section, and never re-describe a person's base look in "prompt" - the token carries it.

WHICH PARAGRAPHS: choose {{count}} paragraph(s) spread across the reply (not all at the end), each showing a DIFFERENT moment. Priority: (1) a picture, video, mirror, screen or photo described in the text - draw exactly that; (2) a clear physical action or interaction between people; (3) a strong expression or reaction; (4) an establishing view of a new place or a new outfit; (5) anything else visual. Skip paragraphs that are only dialogue, thoughts or narration without a visible change.

ONE INSTANT: an image is one frozen moment, like a shutter pressed for a tenth of a second. Never chain actions (wrong: hugging, kissing - pick one) and never describe before / after. PEOPLE: at most 2 people fully in frame; extra people become background (blurred crowd, background people) or are left out. If several people do separate things, pick the one moment that matters most.

FRAME SCOPE: write only what the camera can see in this shot. A lower-body close-up has no face or expression; a bust shot has no shoes; from behind means no eyes, no expression, no front-of-outfit details (use $keyword.back when listed); a covered face means no eye words; fully clothed means nothing under the clothes; a person hidden behind another gets only the visible parts. When you leave out a fixed-look element for these reasons, say why (from behind, face covered, head out of frame) so the image model does not invent it.

CONCRETE: split abstract words and dialogue into visible facts - "under the moon" is moonlight, night sky, backlighting; "she was embarrassed" is a blush, looking away, a hand on her own cheek; "ready to fight" is a low stance, the sword half drawn, narrowed eyes; "he comforted her" is his hand on her head, a gentle smile, looking down at her. Abstract nouns (love, fear, freedom, tension) never appear on their own.

OUTPUT FORMAT (strict): reply with ONLY a JSON array, no prose, no markdown fence. Inside strings never use double quotes (write dialogue as: mouthing the words no no):
[{"p": <paragraph number>, "prompt": "<image prompt WITH $tokens>", "final": "<the same prompt written out for the image model>"}]
- "p" must be one of the paragraph numbers listed, each used at most once. Pick the most visual moments.
- "prompt" = the raw version: people, their stored entries and the TOKENS definitions appear as $tokens (it is stored and re-used when the stored texts change later).
- "final" = the SAME picture with every $token written out for an image model that has never seen the roster: each person gets their base look in ONE short clause (the 4-6 traits that are visible in this frame - no full copy of the stored text), each used entry / token becomes its description folded into the sentence, trimmed of anything not visible in this shot. Same order, same camera, same light, same contact chain as "prompt"; nothing added, nothing dropped, no $ signs left. Rewrite the sentences so the result reads smoothly (a token used as a noun becomes a noun phrase, a token used as an adjective becomes adjectives).
- Produce exactly {{count}} objects unless fewer paragraphs are usable.
{{aspect_rule}}- {{dialect_rule}}

{{example}}`;

const ASPECT_RULE = `- Add "ar" to every object: "portrait" (tall) for one person full body / cowboy shot, an outfit showcase or a vertical action (standing, jumping, hanging); "landscape" (wide) for two people side by side, big environments where people are small, lying poses, wide establishing shots; "square" for face close-ups, bust shots, hand / object close-ups.
`;

/** Prompt length: without / with a scene document (the document spells out place, clothing, expression and pose of everyone). */
const TAG_RANGE = { plain: '25-45', doc: '40-65' };
const WORD_RANGE = { plain: '80-130', doc: '110-170' };

const DIALECT_RULES = {
    tags: `TAG PROMPT: comma-separated danbooru-style tags (lowercase, spaces not underscores), {{tag_range}} tags total, written in this ORDER:
1. RATING + COUNT (2-4): sfw or nsfw; 1girl / 1boy / 2girls...; solo when alone.
2. CAMERA (4-6, always all four): REGION (full body / cowboy shot / upper body / bust / portrait / close-up of <part> / feet out of frame), DISTANCE (wide shot / mid shot / close-up / extreme close-up), VIEWPOINT (front view / three-quarter view / from side / from behind / from above / from below / pov / mirror selfie), FOCUS exactly one (face focus / eye contact / hand focus / breast focus / foot focus / solo focus / object focus). Pick the REGION that just covers the core action (a hand on a cheek: bust or close-up; two people fighting: full body wide shot). Vary REGION and VIEWPOINT between the images of one reply.
3. CAST, per person: $keyword, then every garment with its colour and state, then the ACTION in layers - base pose (standing / sitting / kneeling / lying on back / lying on side / all fours / squatting / leaning forward / arched back), position (on bed / on chair / on floor / against wall / on lap / at table / in doorway / under covers), limbs (arm up / hand on hip / crossed legs / knees together / head tilt / looking back), the core verb of the paragraph, and for EVERY touch, hold or grip a CONTACT CHAIN of three tags: the body part, the verb, the placement (right hand, grabbing hair, hand on another's head · hands, holding cup, cup in hands · arm, hugging from behind, arms around waist · fingers, gripping sheets, hand on bed). Write the chain for BOTH people when both touch. Never write a verb without saying where the hands / feet / mouth are.
4. SETTING (5-8): indoors / outdoors, place type, 2-4 props actually in frame and where they stand, time of day, weather or season, era or genre when not modern (fantasy, cyberpunk, medieval).
5. LIGHTING (2-4, one per line when the scene gives it): SOURCE (sunlight / moonlight / window light / lamp light / candlelight / firelight / neon light / street light / screen light / spotlight), DIRECTION (backlighting / rim lighting / sidelighting / toplighting / underlighting), QUALITY (soft lighting / hard lighting / dramatic shadows / dappled sunlight / light rays / silhouette), TONE (warm lighting / cool lighting / golden hour / blue hour / dim lighting / bright). When the text says nothing, infer from time of day and place (night bedroom: lamp light, sidelighting, dim lighting, warm lighting).
6. EXPRESSION (3-5 per visible face): GAZE (looking at viewer / looking at another / looking away / looking down / looking up / looking back / eye contact / closed eyes / half-closed eyes / sideways glance), EYES (wide-eyed / narrowed eyes / teary eyes / glaring / constricted pupils / sparkling eyes), MOUTH (smile / grin / smirk / open mouth / parted lips / clenched teeth / pout / biting lip / tongue out), EMOTION (blush / embarrassed / nervous / angry / furious / sad / crying / surprised / scared / smug / seductive smile / expressionless / exhausted). No expression tags at all when the face is not visible.
7. EXTRA (0-6) only when the text has them: physiological (sweat, trembling, heavy breathing, steam, goosebumps), effects (motion lines, speed lines, sparkle, dust particles, falling petals), atmosphere (tense atmosphere, warm atmosphere, mystical atmosphere).
Never pad with synonyms; every tag must be visible in the picture. No sentences.`,
    natural: `PROSE PROMPT: write ONE natural-language paragraph of {{word_range}} words in plain descriptive English for a text-to-image model that reads sentences (Flux / Krea). No tag lists, no headings, no brackets, no weights, no quality words (masterpiece, best quality, 8k, highly detailed). Cover these blocks, each in one or two sentences, in this order:
1. SUBJECT: who is in the picture and how many ("A young woman and a man", "One young woman alone"); optionally the medium first ("A candid photograph of...", "An anime illustration of...") when the STYLE asks for it.
2. CAMERA: one sentence - shot size (close-up / medium shot / cowboy shot / full-body shot / wide shot), angle (at eye level / from a low angle / from above / from behind / over her shoulder / from the viewer's own eyes), framing (from the waist up, head and shoulders, feet out of frame) and what is in focus.
3. EACH PERSON: their $keyword or a short stable identifier used consistently ("the taller woman"), their clothing from top to bottom with colours, materials and state (unbuttoned, soaked, pushed off one shoulder, removed and lying on the floor), then their pose and where they are relative to the furniture and to the other person.
4. ACTION and CONTACT: this exact instant, with a clause for every hand, foot and mouth saying where it is and what it touches ("her right hand rests on his cheek, her left grips the rail behind her"). Objects being held get their own clause. Both people get contact clauses when both touch.
5. SETTING: indoors / outdoors, the kind of place, 2-4 props actually in frame and where they stand, time of day, weather.
6. LIGHT: ONE sentence naming source, direction, quality and tone ("Cool moonlight falls through the window behind her, outlining her hair with a thin rim of light and leaving her face in soft shadow").
7. EXPRESSION: gaze (at whom or what), eyes, mouth and the emotion on each visible face; when the face is turned away or covered, say so and describe nothing of it.
8. EXTRA: physical details (sweat, blush, trembling, wet skin), motion (hair flying, skirt caught mid-swing) and the mood in a few words.
EMPHASIS: this model has no weight syntax - emphasise by ORDER (the most important thing in the first two sentences) and by SPACE ("the torn sleeve dominates the foreground", "her hand fills the lower right of the frame"); de-emphasise by pushing to the end with "faintly", "in the background", "out of focus". NO NEGATIVES: never write what should be absent ("no text", "without other people") - state the positive instead ("she is the only person in the frame", "the wall behind her is plain"). Present tense, concrete nouns and verbs; every sentence adds something visible.`,
};

const EXAMPLES = {
    tags: `EXAMPLE (roster has $mara with details $mara.outfit, $mara.back; and $tomas): [{"p": 3, "prompt": "sfw, 1girl, 1boy, upper body, mid shot, from the foot of the bed, three-quarter view, hand focus, $mara sitting on the left edge of a bed with her back half turned to the viewer, $mara.outfit pushed off one shoulder revealing $mara.back, leaning forward, right hand, holding needle, hand over another's side, left hand, pressing gauze, hand on another's stomach, sewing a wound, $tomas lying on his back on the rumpled bed, arms at sides, fingers gripping sheets, dim bedroom, nightstand with a lit lamp on the right, window with closed curtains behind the bed, night, lamp light, sidelighting, dramatic shadows, warm lighting, $mara worried, looking down at another, furrowed brow, parted lips, $tomas closed eyes, clenched teeth, sweat, tense atmosphere", "final": "sfw, 1girl, 1boy, upper body, mid shot, from the foot of the bed, three-quarter view, hand focus, slim young woman, olive skin, long dark braid, sitting on the left edge of a bed, back half turned to the viewer, oversized white shirt pushed off one shoulder, black wing tattoo on shoulder blade, leaning forward, right hand, holding needle, hand over another's side, left hand, pressing gauze, hand on another's stomach, sewing a wound, broad dark-bearded man, lying on his back on the rumpled bed, arms at sides, fingers gripping sheets, dim bedroom, nightstand with a lit lamp on the right, window with closed curtains behind the bed, night, lamp light, sidelighting, soft lighting, warm lighting, focused expression, looking down at the wound, jaw set, eyes closed, clenched teeth}]`,
    natural: `EXAMPLE (roster has $mara with detail $mara.back; and $tomas): [{"p": 3, "prompt": "A young woman and a wounded man in a small dim bedroom at night. Medium shot from the foot of the bed at eye level, framed from the waist up, the focus on her hands and his side with the background softly blurred. $mara sits on the left edge of the bed leaning over him, her shirt slipped off her right shoulder so that $mara.back shows. Her right hand holds a curved needle just above the cut on his ribs while her left presses a folded gauze flat against his stomach. $tomas lies on his back on the rumpled sheets, his fingers gripping the sheet at his sides. The only light is a warm lamp on the nightstand to the right, raking across her face and throwing long shadows toward the drawn curtains behind the bed. Her brow is furrowed and her lips parted as she looks down at the wound; his eyes are shut and his teeth clenched, sweat shining on his chest. The mood is tense and quiet.", "final": "A young woman with a dark braid and a wounded man in a small dim bedroom at night. Medium shot from the foot of the bed at eye level, framed from the waist up, the focus on her hands and his side with the background softly blurred. Mara, slim with olive skin and a long dark braid over one shoulder, sits on the left edge of the bed leaning over him, her shirt slipped off her right shoulder so the black wing tattoo across her shoulder blade shows. Her right hand holds a curved needle just above the cut on his ribs while her left presses a folded gauze flat against his stomach. Tomas, broad and dark-bearded, lies on his back on the rumpled sheets, his fingers gripping the sheet at his sides. The only light is a warm lamp on the nightstand to the right, throwing soft side light across her face and leaving the far wall in shadow. Her jaw is set and her eyes stay on the wound; his eyes are shut, teeth clenched.}]`,
};

/**
 * Step 2 contract, appended to EVERY preset system (built-in, overridden or user-made) when a scene document is
 * given: the document must actually show up in each prompt - place, layout, clothing with colours + state,
 * expression, action, pose / position of every person. Without it models paraphrase the paragraph and drop the rest.
 */
const DOC_LENGTH = {
    tags: 'With a document the prompt is longer than usual: 40-65 tags, because place, props, clothing, expression and pose of every person are all spelled out.',
    natural: 'With a document the paragraph is longer than usual: 110-170 words, because place, props, clothing, expression and pose of every person are all spelled out.',
};
const DOC_EXAMPLES = {
    tags: `EXAMPLE with a document (tags): [{"p": 3, "prompt": "sfw, 1girl, 1boy, upper body, mid shot, from the foot of the bed, three-quarter view, hand focus, $mara sitting on the left edge of a bed with her back half turned to the viewer, oversized white shirt unbuttoned and pushed off her right shoulder, black cotton shorts, barefoot, leaning forward, right hand, holding needle, hand over another's side, left hand, pressing gauze, hand on another's stomach, sewing a wound, $tomas lying on his back on the rumpled bed, grey tank top pulled up to his chest, dark jeans, arms at sides, fingers gripping sheets, dim bedroom, nightstand with a lit brass lamp on the right, window with closed curtains behind the bed, clothes on the wooden floor, night, lamp light, sidelighting, dramatic shadows, warm lighting, dim lighting, $mara worried, looking down at another, furrowed brow, parted lips, $tomas closed eyes, clenched teeth, sweat, trembling, blood on cloth, tense atmosphere", "final": "sfw, 1girl, 1boy, upper body, mid shot, from the foot of the bed, three-quarter view, hand focus, slim young woman, olive skin, long dark braid, sitting on the left edge of a bed, back half turned to the viewer, oversized white shirt unbuttoned, shirt pushed off right shoulder, black wing tattoo on shoulder blade, black cotton shorts, barefoot, leaning forward, right hand, holding needle, hand over another's side, left hand, pressing gauze, hand on another's stomach, sewing a wound, broad dark-bearded man, lying on his back on the rumpled bed, grey tank top pulled up to his chest, dark jeans, arms at sides, fingers gripping sheets, dim bedroom, nightstand with a lit brass lamp on the right, window with closed curtains behind the bed, night, lamp light, sidelighting, soft lighting, warm lighting, focused expression, looking down at the wound, jaw set, eyes closed, clenched teeth}]`,
    natural: `EXAMPLE with a document (prose): [{"p": 3, "prompt": "A young woman and a wounded man in a small dim bedroom at night. Medium shot from the foot of the bed at eye level, framed from the waist up, the focus on her hands and his side with the background softly blurred. $mara sits on the left edge of the bed leaning over him, wearing an oversized white linen shirt unbuttoned and slipped off her right shoulder so that $mara.back shows, black cotton shorts, barefoot. Her right hand holds a curved needle just above the cut on his ribs while her left presses a folded gauze flat against his stomach. $tomas lies on his back on the rumpled sheets, a grey tank top pushed up to his chest, dark jeans, his fingers gripping the sheet at his sides. The only light is a warm brass lamp on the nightstand to the right, raking across her face and throwing long shadows toward the drawn curtains behind the bed. Her brow is furrowed and her lips parted as she looks down at the wound; his eyes are shut and his teeth clenched, sweat shining on his chest. Her fingers tremble slightly. Clothes lie faintly visible on the wooden floor by the door; the mood is tense and quiet.", "final": "A young woman with a dark braid and a wounded man in a small dim bedroom at night. Medium shot from the foot of the bed at eye level, framed from the waist up, the focus on her hands and his side with the background softly blurred. Mara, slim with olive skin and a long dark braid, sits on the left edge of the bed leaning over him, wearing an oversized white linen shirt unbuttoned and slipped off her right shoulder so the black wing tattoo across her shoulder blade shows, black cotton shorts, barefoot. Her right hand holds a curved needle just above the cut on his ribs while her left presses a folded gauze flat against his stomach. Tomas, broad and dark-bearded, lies on his back on the rumpled sheets, a grey tank top pushed up to his chest, dark jeans, his fingers gripping the sheet at his sides. A warm brass lamp on the nightstand to the right throws soft side light across her face; the curtains behind the bed are closed and the far wall stays in shadow. Her jaw is set and her eyes stay on the wound; his eyes are shut, teeth clenched.}]`,
};
export const SCENE_DOC_RULES = `

SCENE DOCUMENT RULES (a SCENE DOCUMENT is given - these rules override anything above that conflicts):
- The document is the source of truth for this reply. The paragraph only picks the MOMENT and the CAMERA; where it happens, who is present, what they wear, how they feel and where they are positioned all come from the document. TRANSLATE the document into the prompt - never summarise the paragraph alone.
- EVERY prompt must contain, explicitly:
  (a) WHERE: indoors/outdoors and the place type from LOCATION, the furniture and props from LAYOUT that would be in the frame and where they stand (bed against the wall, lit lamp on the nightstand, rain on the window...), time of day and the lighting.
  (b) for EACH person present in that shot: their $keyword, then their clothing written out in words from that person's WEARING lines with colours and state (never just "clothes" or "dressed" - write e.g. "unbuttoned white linen shirt, black cotton shorts, barefoot"), their EXPRESSION and gaze, the action of that paragraph from DOING with its points of contact, and their POSE / POSITION relative to the furniture and to the other people (sitting on the left edge of the bed, kneeling at his feet, facing away from the viewer).
- Clothing always comes from the document in words. Do NOT replace it with a $keyword.outfit token. Other detail tokens ($keyword.back, .nsfw, .body...) are still written as tokens when that part is visible.
- Never write anything the document contradicts, and never drop the place, the lighting or the clothing because the paragraph does not repeat them.
- {{doc_length}}
{{doc_example}}`;

const ROLE = `You are the illustration director of a roleplay chat. You read the latest reply split into numbered paragraphs plus short context or a scene document, choose which paragraphs deserve an image and write the image prompt for each.
Keep continuity with earlier context (location, time of day, clothing). Focus on what is visually happening in that paragraph.`;

const KREA_RULES = `

MODEL: the prompt goes to Krea / Flux, a model that reads SENTENCES, not tags. It has no weight syntax, no negative prompt and ignores quality words - a clear paragraph of plain English is what works.
CAMERA WORDS (always as part of a sentence, never as bare tags like "1girl" or "pov hands"): shot size - extreme close-up, close-up, medium close-up, medium shot, cowboy shot (mid-thigh up), full-body shot, wide shot, establishing shot. Angle - at eye level, from slightly above, from directly above, from a low angle, from ground level, from behind, three-quarter view, in profile, over-the-shoulder, from the viewer's own point of view (the viewer's hands may be visible). Framing - centred, off-centre to the left / right, tight framing, head and shoulders, from the waist up, feet cut off by the frame. Lens feel - shallow depth of field with a blurred background, everything in sharp focus, slight wide-angle distortion, motion blur on the moving hand. Pick a different shot size or angle for each image of the same reply.
LIGHT SENTENCE: always one sentence naming source + direction + quality + tone. Sources: sunlight through a window, overcast daylight, golden late-afternoon sun, moonlight, a bedside lamp, candlelight, firelight, neon signs, a phone screen, fluorescent ceiling lights, a single spotlight. Direction: from the left / right / behind (rim light, silhouette) / above / below / front. Quality: soft and diffuse, hard with sharp shadows, dappled through leaves, hazy, high contrast. Tone: warm amber, cool blue, neutral, dim, bright and even.
TAG INPUT: when the ROSTER, the SCENE DOCUMENT or a draft is written as comma-separated danbooru tags, rewrite it into sentences: 1girl becomes "a young woman", 1boy "a man", 2girls "two young women", solo "alone in the frame"; looks join into one clause with the person first; clothing tags become "wears ..." top to bottom with colours, state tags (open shirt, torn, wet) become adjectives on that garment; camera tags become the camera sentence, lighting tags the light sentence; interaction tags name WHOSE hand and WHOSE cheek; weights (tag:1.3), {tag}, [tag] lose their syntax - emphasised tags go earlier, de-emphasised ones later with "faintly"; quality tags and underscores disappear. Never leave a comma-separated list in the output.`;

const NAI_RULES = `

MODEL: the prompt goes to NovelAI Diffusion / Illustrious-class anime models that read danbooru TAGS. Use the exact danbooru tag names (looking at viewer, not looking at the viewer; from behind, not from the back; sitting, not sitting down; hand on another's cheek for a touch on someone else, hand on own cheek for oneself). Quality tags and the negative prompt are added automatically - never write them.
GROUPING: keep every tag that belongs to a person right after that person's $keyword (clothing, pose, contact chain, expression) so a two-character model attributes them correctly; put shared tags (setting, lighting, atmosphere) after both people.
EMPHASIS: do not use weight syntax ((tag:1.2), {tag}, [tag]) - emphasise by putting the defining tags earlier and by adding the more specific tag (grabbing hair instead of touching hair, deep skin indentation instead of squeezing). One specific tag beats three vague ones.
BODY: when the pose implies deformation write it (lying on back: breasts spread out; on all fours: hanging breasts; pressed against glass: breasts on glass; gripping flesh: deep skin indentation). Standing poses: feet planted, heavy stance when the text implies weight.`;

/** `dialect` on a preset forces that dialect for step 2 (Krea prose / NAI tags) regardless of the global setting. */
export const BUILTIN_PRESETS = [
    {
        id: 'scene_default', builtin: true, name: 'Scene (default)',
        system: ROLE + OUTPUT_RULES,
    },
    {
        id: 'krea_natural', builtin: true, name: 'Krea / Flux — natural prose', dialect: 'natural',
        system: ROLE + KREA_RULES + OUTPUT_RULES,
    },
    {
        id: 'nai_tags', builtin: true, name: 'NovelAI / Illustrious — tags', dialect: 'tags',
        system: ROLE + NAI_RULES + OUTPUT_RULES,
    },
    {
        id: 'portrait_focus', builtin: true, name: 'Portrait / expression focus',
        system: `You are an illustration director. Prefer close-up or medium shots of the speaking character's face and expression in the chosen paragraph. Emphasise emotion, gaze, lighting on the face.` + OUTPUT_RULES,
    },
    {
        id: 'action_wide', builtin: true, name: 'Action / wide shot',
        system: `You are an illustration director. Prefer full-body or wide shots that show the interaction between characters and the environment. Emphasise poses, positioning of each character, and the setting.` + OUTPUT_RULES,
    },
    {
        id: 'nsfw_explicit', builtin: true, name: 'NSFW explicit',
        system: `You are an illustration director for adult roleplay. The reader wants the sex shown, not implied: choose the most explicit visual instant of the reply and describe it frankly, in the vocabulary an adult image model is trained on. Do not censor, soften, imply or skip.

NSFW PRIORITY (replaces the general paragraph priority when the reply contains sexual content): (1) penetration, oral or manual sex in progress, orgasm, ejaculation - the instant of contact itself; (2) undressing, exposure, a body part revealed or grabbed; (3) foreplay: kissing with hands under clothes, groping, grinding; (4) the after: cum on skin, dishevelled clothes, sweat, tangled sheets; (5) only then a non-sexual moment. With 2+ images spread them over DIFFERENT stages / angles (a close-up and a mid shot, never two similar frames).

FOCUS OVER WIDE: sex reads in close. Default to close-up or mid shot on the point of contact (the join of the bodies, a hand on a breast, a mouth on skin) with the faces or the reaction as the second element; use a full-body or wide shot only for a position that needs the whole body to read (standing sex, against a wall, bent over a table) and never more than once per reply. Name the FOCUS tag explicitly (penetration focus / breast focus / ass focus / face focus / crotch focus / hand focus / pov). Close framing means no floor, no ceiling, no props unless a hand is on them.

EXPLICIT ANATOMY AND ACTS: name the body parts (penis / erect penis / vaginal / anal / breasts / nipples / pussy / ass / thighs / cum) and the act with standard tags (vaginal, anal, fellatio, cunnilingus, handjob, fingering, paizuri, missionary, doggystyle, cowgirl, reverse cowgirl, prone bone, standing sex, mating press, spooning, sex from behind, from behind, spread legs, legs up, legs over shoulders, deep penetration, cum inside, cum on body, cum on face, cum on breasts, after sex). For prose: plain anatomical words in full sentences ("his cock is buried to the base in her pussy", "her nipples are hard against his palm"), never euphemism ("their bodies joined").

MOTION IN A STILL: an image model cannot show a sequence, so freeze the peak and paint the motion into it - motion lines, motion blur on the moving part (blurred hips, blurred hand), bouncing breasts, jiggling ass, hair in motion, sweat drops flying, saliva trail, cum dripping / cum string, sheets bunched by a grip, a mattress dented under a knee, skin pressed / squished where bodies meet, red hand marks, heart-shaped pupils, rolling eyes, tongue out, ahegao, trembling / shaking (drawn as motion lines around thighs), arched back, curled toes. Pick 2-4 of these per shot; they carry the intensity of the act.

BODY PHYSICS: describe what the pose does to the bodies - breasts pressed together / hanging / bouncing, thighs squeezed, ass spread by hands, belly bulge, stomach tensed, back arched, knees pushed to the chest, fingers sinking into flesh, hair pulled taut - and exactly which hand or mouth is where (CONTACT CHAIN for every touch).

FLUIDS AND STATE: sweat, drool, tears of pleasure, pussy juice, precum, cum (where: inside dripping out / on stomach / on face / on breasts / on ass / cum pool), wet skin, flushed skin, shiny skin, nipple erection, blush over the whole body, messy hair, smeared lipstick.

CLOTHING STATE: clothes rarely vanish - say what is still on and how: shirt open, bra pushed up / bra pull, panties aside / panties around one leg / panties around ankles, skirt lifted, pants pulled down to the knees, stockings kept on, torn pantyhose, unbuttoned, unzipped, half-off, straps slipped, wet clothes clinging, clothes lying on the floor. Write the state per person right after their $keyword.

EXPRESSION UNDER SEX: per visible face pick from - half-closed eyes, eyes rolled up, heart-shaped pupils, tears in eyes, open mouth, tongue out, biting lip, moaning (open mouth), gritted teeth, blushing hard, sweat on temples, dazed / fucked silly / ahegao, looking at the viewer, looking back over the shoulder, eye contact between them.

FRAME SCOPE still applies: a crotch close-up has no faces; from behind shows no eyes; a pov shot shows the viewer's hands only. RATING: start tag prompts with "nsfw, explicit" (or "nsfw, questionable" for exposure without sex). Never use quotes for dialogue - moans are written as expressions, not words.` + OUTPUT_RULES,
    },
    {
        id: 'sfw_safe', builtin: true, name: 'SFW only',
        system: `You are an illustration director. Choose only safe-for-work moments. If the paragraph is explicit, depict a tasteful, clothed, non-sexual framing instead.` + OUTPUT_RULES,
    },
    {
        id: 'background_only', builtin: true, name: 'Background / environment',
        system: `You are an illustration director. Produce prompts of the environment only: no people ("no humans"). Describe architecture, nature, weather, time of day, lighting, atmosphere.` + OUTPUT_RULES,
    },
    {
        id: 'pov_user', builtin: true, name: 'POV of the user',
        system: `You are an illustration director. Every image is from the user's first-person point of view (pov). The user's own body appears only as hands/arms if relevant. The other characters face the viewer.` + OUTPUT_RULES,
    },
    {
        id: 'comic_panel', builtin: true, name: 'Comic panel per beat',
        system: `You are an illustration director laying out a comic. Treat each chosen paragraph as one panel: strong composition, clear silhouette, expressive faces, dynamic angle. Vary the shot type between panels.` + OUTPUT_RULES,
    },
];

/** Dialect a preset runs step 2 in: the preset's own (Krea / NAI presets) or the global setting. */
export function presetDialect(preset, fallback) {
    return DIALECT_RULES[preset?.dialect] ? preset.dialect : (DIALECT_RULES[fallback] ? fallback : 'tags');
}

/**
 * Dialect every step actually uses (translate, refine, compiler, profile): the selected preset's forced dialect
 * (Krea -> natural, NAI -> tags) wins over the global Generate setting, so the whole chain speaks one language.
 */
export function effectiveDialect(settings, presetId) {
    const g = settings?.generate ?? {};
    const preset = findPreset(settings, presetId ?? g.presetId);
    if (DIALECT_RULES[preset?.dialect]) return preset.dialect;
    // Model profile of the active backend (set in Connection) beats the global switch.
    const be = settings?.connection?.backend;
    const prof = settings?.connection?.profiles?.[be]?.[settings?.connection?.[be]?.model];
    if (DIALECT_RULES[prof?.dialect]) return prof.dialect;
    return presetDialect(preset, g.dialect);
}

export function createPreset(partial = {}) {
    return {
        id: partial.id || uuid(),
        builtin: false,
        name: partial.name || 'New preset',
        system: partial.system || BUILTIN_PRESETS[0].system,
        ...(partial.dialect ? { dialect: partial.dialect } : {}),
    };
}

/** Built-ins with the user's overrides applied (`overridden: true` when a saved text replaces the default), then user presets. */
export function allPresets(settings) {
    const ov = settings.data.presetOverrides ?? {};
    const builtins = BUILTIN_PRESETS.map(p => typeof ov[p.id] === 'string' ? { ...p, system: ov[p.id], overridden: true } : p);
    return [...builtins, ...(settings.data.presets ?? [])];
}

/** Save `system` over a preset in place: built-in -> override entry, user preset -> its own record. */
export function overwritePreset(settings, id, system) {
    if (BUILTIN_PRESETS.some(p => p.id === id)) {
        settings.data.presetOverrides ??= {};
        const def = BUILTIN_PRESETS.find(p => p.id === id).system;
        if (system === def) delete settings.data.presetOverrides[id]; else settings.data.presetOverrides[id] = system;
        return true;
    }
    const own = (settings.data.presets ?? []).find(p => p.id === id);
    if (!own) return false;
    own.system = system;
    return true;
}

/** Drop the override of a built-in preset (back to the shipped text). */
export function resetPreset(settings, id) {
    if (settings.data.presetOverrides) delete settings.data.presetOverrides[id];
}

export function findPreset(settings, id) {
    return allPresets(settings).find(p => p.id === id) ?? BUILTIN_PRESETS[0];
}

/**
 * Step 2 messages: scene document (+ paragraphs) -> N image prompts.
 * @param {object} preset
 * @param {{ paragraphs: {index:number,text:string}[], count:number, roster:string, context?:string, dialect:string, sceneDoc?:string, fixed?:boolean, autoAspect?:boolean }} a
 *   sceneDoc - the scene document written in step 1 (authoritative). Earlier context is omitted when it is given.
 *   fixed    - the listed paragraphs are exactly the ones to illustrate (regenerate: keep every image slot)
 */
export function renderPlannerPrompt(preset, a) {
    const doc = String(a.sceneDoc ?? '').trim();
    const dialect = presetDialect(preset, a.dialect);
    const len = doc ? 'doc' : 'plain';
    // The document contract is appended to the preset text so overridden / user presets get it too.
    const system = (preset.system + (doc ? SCENE_DOC_RULES : ''))
        .replaceAll('{{count}}', String(a.count))
        .replaceAll('{{aspect_rule}}', a.autoAspect ? ASPECT_RULE : '')
        .replaceAll('{{dialect_rule}}', DIALECT_RULES[dialect])
        .replaceAll('{{tag_range}}', TAG_RANGE[len])
        .replaceAll('{{word_range}}', WORD_RANGE[len])
        .replaceAll('{{doc_length}}', DOC_LENGTH[dialect])
        .replaceAll('{{example}}', doc ? '' : EXAMPLES[dialect])
        .replaceAll('{{doc_example}}', DOC_EXAMPLES[dialect]);
    const paraBlock = a.paragraphs.map(p => `[${p.index}] ${p.text}`).join('\n\n');
    const what = doc
        ? 'translate the SCENE DOCUMENT into the prompt of each (place + props from LAYOUT, lighting, and for every person present: clothing in words with colours and state, expression, the action of that paragraph, pose / position)'
        : 'describe the SCENE of each (actions, poses, setting, lighting, camera)';
    const ask = a.fixed
        ? `Write one prompt for EACH of the ${a.count} paragraph(s) listed (use every listed "p" exactly once), ${what}, and reply with the JSON array only.`
        : `Choose ${a.count} paragraph(s), ${what}, and reply with the JSON array only.`;
    const user = [
        a.roster ? `ROSTER (keyword -> who they are, base look, stored details and world entries; use the tokens in "prompt", write them out in "final"):\n${a.roster}` : 'ROSTER: (none)',
        doc ? `SCENE DOCUMENT (authoritative for this reply - translate it into the prompts):\n${doc}` : '',
        !doc && a.context ? `EARLIER CONTEXT:\n${a.context}` : '',
        `LATEST REPLY, NUMBERED PARAGRAPHS:\n${paraBlock}`,
        ask,
    ].filter(Boolean).join('\n\n');
    return { system, user };
}

/**
 * Pull the first JSON array out of an LLM reply. Tolerates prose around it, a ```json fence,
 * and unescaped double quotes INSIDE string values (e.g. a "no, no" plea).
 * Strict parse of [first '[' .. last ']'] first; if that fails, quotes that are not followed by a
 * JSON structural character are re-escaped and parsing is retried.
 * @returns {any[]|null}
 */
export function extractJsonArray(text) {
    const s = String(text ?? '');
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    const tryParse = str => { try { const v = JSON.parse(str); return Array.isArray(v) ? v : null; } catch { return null; } };
    const slice = s.slice(start, end + 1);
    return tryParse(slice) ?? tryParse(repairQuotes(slice)) ?? looseObjects(slice);
}

/**
 * Last resort for replies whose strings are closed with an ESCAPED quote (backslash + quote before the brace)
 * or that mix raw quotes: split on object boundaries and read every "key": number plus the "prompt" text up to
 * the LAST quote of the chunk, so inner / escaped quotes cannot break it.
 * @returns {object[]|null}
 */
function looseObjects(str) {
    const out = [];
    for (let raw of str.split(/\}\s*,\s*\{/)) {
        raw = raw.replace(/^[\s[{]+/, '').replace(/[\s\]}]+$/, '');
        const obj = {};
        for (const m of raw.matchAll(/"([A-Za-z_]\w*)"\s*:\s*(-?\d+(?:\.\d+)?)/g)) obj[m[1]] = Number(m[2]);
        const t = raw.match(/"(prompt|text|scene)"\s*:\s*"([\s\S]*)$/);
        if (t) {
            let v = t[2];
            const q = v.lastIndexOf('"');
            if (q >= 0) v = v.slice(0, q);
            if (v.endsWith('\\')) v = v.slice(0, -1);
            obj[t[1]] = v.replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
        }
        if (Object.keys(obj).length) out.push(obj);
    }
    return out.length ? out : null;
}

/** Escape double quotes that sit inside string values: a quote closes a string only when the next non-space char is , : ] or }. */
function repairQuotes(str) {
    let out = '', inStr = false;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (!inStr) { if (ch === '"') inStr = true; out += ch; continue; }
        if (ch === '\\') { out += ch + (str[i + 1] ?? ''); i++; continue; }
        if (ch !== '"') { out += ch; continue; }
        if (/^\s*[,:\]}]/.test(str.slice(i + 1))) { inStr = false; out += ch; } else out += '\\"';
    }
    return out;
}

/** Parse planner reply into [{p, prompt, final?, ar?}] restricted to valid paragraph numbers. final = token-free prompt for the image model. */
export function parsePlan(text, validIndexes) {
    const s = String(text ?? '');
    const arr = extractJsonArray(s);
    if (!Array.isArray(arr)) return [];
    const valid = new Set(validIndexes);
    const seen = new Set();
    const out = [];
    for (const item of arr) {
        const p = Number(item?.p);
        const prompt = String(item?.prompt ?? '').trim();
        if (!valid.has(p) || !prompt || seen.has(p)) continue;
        seen.add(p);
        const ar = String(item?.ar ?? '').toLowerCase();
        const final = String(item?.final ?? '').trim();
        const o = { p, prompt };
        if (final && !/\$[\p{L}]/u.test(final)) o.final = final; // a "final" that still carries $tokens is useless to the image model
        if (['portrait', 'landscape', 'square'].includes(ar)) o.ar = ar;
        out.push(o);
    }
    return out.sort((x, y) => x.p - y.p);
}
