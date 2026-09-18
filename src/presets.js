// IF Imgen - prompt translator presets (step 2: scene document -> image prompts), builtin + user. Pure module.
import { uuid } from './util.js';

const OUTPUT_RULES = `

WHAT YOU WRITE: an image prompt is a description of the SCENE in that paragraph -- who is present, what each person is doing, pose, expression, clothing state, where they are, lighting, camera angle/shot type. It is NOT a character sheet. You never retell or continue the story and you never output anything except the requested JSON.

CAST: the ROSTER lists each known person as $keyword with their BASE LOOK (fixed appearance) and their stored entries as $keyword.key: text (details = the person's own look, clothes, body parts; world = places, side characters and recurring items of that person's story). The SCENE DOCUMENT may define more tokens in its TOKENS section - those count as listed too. Mention each person present ONLY as their $keyword, then describe what they are doing. If a paragraph has two people, mention both and describe both. If nobody from the roster is in the paragraph, describe the person generically (a young woman with short brown hair...) without any $keyword. CONFIDENCE: use a $keyword only when you are at least 70% sure the text means that person; otherwise describe generically instead of guessing.

TOKENS: in the raw "prompt", when a stored entry IS what is worn, on show or where the scene happens, write the TOKEN exactly as listed (e.g. "...walking away in the rain, wet $yenka.outfit clinging to her skin, showing $yenka.back", "$seb sitting on $seb.sofa in $seb.apartment") and add only what differs right now (unbuttoned, soaked, pushed off one shoulder). Never reference a token that is not listed or defined in the document, and never write what a token contains in the raw "prompt".

TWO VERSIONS of every prompt:
- "prompt" (raw): keeps every $keyword and $keyword.key token. Do NOT repeat a person's base look here - the token stands for it.
- "final": the SAME sentence with every token replaced by its stored text WORD FOR WORD. $keyword -> that person's FULL base look; $keyword.key -> the FULL text of that entry, exactly as listed in the ROSTER. You may change grammar only so it reads (his / her, a / the, singular, verb form, commas between items) - never drop, shorten, summarise or reword a stored detail, never pick "a few traits", never leave out a part because the shot does not show it: the stored text IS the character, the image model needs all of it. Add nothing that is not in the raw prompt or in a stored text. The final is long by design; the length rule below counts the scene words only, not the inserted texts.
- Both versions describe the same instant, same framing, same people. Never leave a $ in "final" - a final with a $ is discarded. (The looks inside the EXAMPLES below are shortened for reading; yours are inserted in full.)

WHICH PARAGRAPHS: choose {{count}} paragraph(s) spread across the reply (not all at the end), each showing a DIFFERENT moment. Priority: (1) a picture, video, mirror, screen or photo described in the text - draw exactly that; (2) a clear physical action or interaction between people; (3) a strong expression or reaction; (4) an establishing view of a new place or a new outfit; (5) anything else visual. Skip paragraphs that are only dialogue, thoughts or narration without a visible change.

ONE INSTANT: an image is one frozen moment, like a shutter pressed for a tenth of a second. Never chain actions (wrong: hugging, kissing - pick one) and never describe before / after. PEOPLE: at most 2 people fully in frame; extra people become background (blurred crowd, background people) or are left out. If several people do separate things, pick the one moment that matters most.

FRAME SCOPE: write only what the camera can see in this shot. A lower-body close-up has no face or expression; a bust shot has no shoes; from behind means no eyes, no expression, no front-of-outfit details (use $keyword.back when listed); a covered face means no eye words; fully clothed means nothing under the clothes; a person hidden behind another gets only the visible parts. When you leave out a fixed-look element for these reasons, say why (from behind, face covered, head out of frame) so the image model does not invent it.

CONCRETE: split abstract words and dialogue into visible facts - "under the moon" is moonlight, night sky, backlighting; "she was embarrassed" is a blush, looking away, a hand on her own cheek; "ready to fight" is a low stance, the sword half drawn, narrowed eyes; "he comforted her" is his hand on her head, a gentle smile, looking down at her. Abstract nouns (love, fear, freedom, tension) never appear on their own.

OUTPUT FORMAT (strict): reply with ONLY a JSON array, no prose, no markdown fence. Inside "prompt" and "final" never use double quotes (write dialogue as: mouthing the words no no):
[{"p": <paragraph number>, "prompt": "<raw prompt with $tokens>", "final": "<the same prompt written out, no $ tokens>"}]
- "p" must be one of the paragraph numbers listed, each used at most once. Pick the most visual moments.
- Both "prompt" and "final" are required for every object.
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
    tags: `EXAMPLE (roster: $mara - base look: 1girl, long red hair, green eyes, freckles, slender; $mara.outfit: oversized white shirt, black cotton shorts; $mara.back: a large phoenix tattoo across her back; $tomas - base look: 1boy, short black hair, stubble, muscular): [{"p": 3, "prompt": "sfw, 1girl, 1boy, upper body, mid shot, from the foot of the bed, three-quarter view, hand focus, $mara sitting on the left edge of a bed with her back half turned to the viewer, $mara.outfit pushed off one shoulder revealing $mara.back, leaning forward, right hand, holding needle, hand over another's side, left hand, pressing gauze, hand on another's stomach, sewing a wound, $tomas lying on his back on the rumpled bed, arms at sides, fingers gripping sheets, dim bedroom, nightstand with a lit lamp on the right, window with closed curtains behind the bed, night, lamp light, sidelighting, dramatic shadows, warm lighting, $mara worried, looking down at another, furrowed brow, parted lips, $tomas closed eyes, clenched teeth, sweat, tense atmosphere", "final": "sfw, 1girl, 1boy, upper body, mid shot, from the foot of the bed, three-quarter view, hand focus, 1girl long red hair, slender, sitting on the left edge of a bed with her back half turned to the viewer, oversized white shirt pushed off one shoulder, phoenix tattoo on her back, leaning forward, right hand, holding needle, hand over another's side, left hand, pressing gauze, hand on another's stomach, sewing a wound, 1boy short black hair, stubble, muscular, lying on his back on the rumpled bed, arms at sides, fingers gripping sheets, dim bedroom, nightstand with a lit lamp on the right, window with closed curtains behind the bed, night, lamp light, sidelighting, dramatic shadows, warm lighting, worried, looking down at another, furrowed brow, parted lips, closed eyes, clenched teeth, sweat, tense atmosphere"}]`,
    natural: `EXAMPLE (roster: $mara - base look: a slender young woman with long red hair, green eyes and freckles; $mara.back: a large phoenix tattoo across her back; $tomas - base look: a muscular man with short black hair and stubble): [{"p": 3, "prompt": "A young woman and a wounded man in a small dim bedroom at night. Medium shot from the foot of the bed at eye level, framed from the waist up, the focus on her hands and his side with the background softly blurred. $mara sits on the left edge of the bed leaning over him, her shirt slipped off her right shoulder so that $mara.back shows. Her right hand holds a curved needle just above the cut on his ribs while her left presses a folded gauze flat against his stomach. $tomas lies on his back on the rumpled sheets, his fingers gripping the sheet at his sides. The only light is a warm lamp on the nightstand to the right, raking across her face and throwing long shadows toward the drawn curtains behind the bed. Her brow is furrowed and her lips parted as she looks down at the wound; his eyes are shut and his teeth clenched, sweat shining on his chest. The mood is tense and quiet.", "final": "A young woman and a wounded man in a small dim bedroom at night. Medium shot from the foot of the bed at eye level, framed from the waist up, the focus on her hands and his side with the background softly blurred. Mara, a slender young woman with long red hair and freckles, sits on the left edge of the bed leaning over him, her shirt slipped off her right shoulder so that the phoenix tattoo across her back shows. Her right hand holds a curved needle just above the cut on his ribs while her left presses a folded gauze flat against his stomach. Tomas, a muscular man with short black hair and stubble, lies on his back on the rumpled sheets, his fingers gripping the sheet at his sides. The only light is a warm lamp on the nightstand to the right, raking across her face and throwing long shadows toward the drawn curtains behind the bed. Her brow is furrowed and her lips parted as she looks down at the wound; his eyes are shut and his teeth clenched, sweat shining on his chest. The mood is tense and quiet."}]`,
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
    tags: `EXAMPLE with a document (tags; roster: $mara - base look: 1girl, long red hair, green eyes, freckles, slender; $mara.back: a large phoenix tattoo across her back; $tomas - base look: 1boy, short black hair, stubble, muscular; document WEARING: $mara: oversized white shirt, unbuttoned, pushed off right shoulder, black cotton shorts, barefoot): [{"p": 3, "prompt": "sfw, 1girl, 1boy, upper body, mid shot, from the foot of the bed, three-quarter view, hand focus, $mara sitting on the left edge of a bed with her back half turned to the viewer, oversized white shirt unbuttoned and pushed off her right shoulder revealing $mara.back, black cotton shorts, barefoot, leaning forward, right hand, holding needle, hand over another's side, left hand, pressing gauze, hand on another's stomach, sewing a wound, $tomas lying on his back on the rumpled bed, grey tank top pulled up to his chest, dark jeans, arms at sides, fingers gripping sheets, dim bedroom, nightstand with a lit brass lamp on the right, window with closed curtains behind the bed, clothes on the wooden floor, night, lamp light, sidelighting, dramatic shadows, warm lighting, dim lighting, $mara worried, looking down at another, furrowed brow, parted lips, $tomas closed eyes, clenched teeth, sweat, trembling, blood on cloth, tense atmosphere", "final": "sfw, 1girl, 1boy, upper body, mid shot, from the foot of the bed, three-quarter view, hand focus, 1girl long red hair, freckles, slender, sitting on the left edge of a bed with her back half turned to the viewer, oversized white shirt unbuttoned and pushed off her right shoulder, phoenix tattoo on her back, black cotton shorts, barefoot, leaning forward, right hand, holding needle, hand over another's side, left hand, pressing gauze, hand on another's stomach, sewing a wound, 1boy short black hair, stubble, muscular, lying on his back on the rumpled bed, grey tank top pulled up to his chest, dark jeans, arms at sides, fingers gripping sheets, dim bedroom, nightstand with a lit brass lamp on the right, window with closed curtains behind the bed, clothes on the wooden floor, night, lamp light, sidelighting, dramatic shadows, warm lighting, dim lighting, worried, looking down at another, furrowed brow, parted lips, closed eyes, clenched teeth, sweat, trembling, blood on cloth, tense atmosphere"}]`,
    natural: `EXAMPLE with a document (prose; roster: $mara - base look: a slender young woman with long red hair, green eyes and freckles; $mara.back: a large phoenix tattoo across her back; $tomas - base look: a muscular man with short black hair and stubble; document WEARING: $mara: oversized white linen shirt, unbuttoned, pushed off right shoulder, black cotton shorts, barefoot): [{"p": 3, "prompt": "A young woman and a wounded man in a small dim bedroom at night. Medium shot from the foot of the bed at eye level, framed from the waist up, the focus on her hands and his side with the background softly blurred. $mara sits on the left edge of the bed leaning over him, wearing an oversized white linen shirt unbuttoned and slipped off her right shoulder so that $mara.back shows, black cotton shorts, barefoot. Her right hand holds a curved needle just above the cut on his ribs while her left presses a folded gauze flat against his stomach. $tomas lies on his back on the rumpled sheets, a grey tank top pushed up to his chest, dark jeans, his fingers gripping the sheet at his sides. The only light is a warm brass lamp on the nightstand to the right, raking across her face and throwing long shadows toward the drawn curtains behind the bed. Her brow is furrowed and her lips parted as she looks down at the wound; his eyes are shut and his teeth clenched, sweat shining on his chest. Her fingers tremble slightly. Clothes lie faintly visible on the wooden floor by the door; the mood is tense and quiet.", "final": "A young woman and a wounded man in a small dim bedroom at night. Medium shot from the foot of the bed at eye level, framed from the waist up, the focus on her hands and his side with the background softly blurred. Mara, a slender young woman with long red hair and freckles, sits on the left edge of the bed leaning over him, wearing an oversized white linen shirt unbuttoned and slipped off her right shoulder so that the phoenix tattoo across her back shows, black cotton shorts, barefoot. Her right hand holds a curved needle just above the cut on his ribs while her left presses a folded gauze flat against his stomach. Tomas, a muscular man with short black hair and stubble, lies on his back on the rumpled sheets, a grey tank top pushed up to his chest, dark jeans, his fingers gripping the sheet at his sides. The only light is a warm brass lamp on the nightstand to the right, raking across her face and throwing long shadows toward the drawn curtains behind the bed. Her brow is furrowed and her lips parted as she looks down at the wound; his eyes are shut and his teeth clenched, sweat shining on his chest. Her fingers tremble slightly. Clothes lie faintly visible on the wooden floor by the door; the mood is tense and quiet."}]`,
};
// NSFW: written from the danbooru tag groups (sex acts, sexual positions, face / expression, image composition,
// body fluids, sexual attire). Inserted after ROLE; the preset also swaps the default example for its own three shots.
const NSFW_RULES = `
NSFW MODE. Sexual content is expected and drawn plainly. Never soften, imply or fade to black; never skip a paragraph because it is explicit. Everything the text shows, the prompt shows. Adults only.

WHAT TO DRAW (priority, highest first):
(1) the sexual act itself - the contact point named plainly and given the frame (penetration, oral, hands, grinding);
(2) climax / fluids the instant they appear (cum, squirt, drool, sweat);
(3) a body part exposed or a garment removed for the first time in the reply (name the part, the garment and how it moved);
(4) the reaction while it happens (ahegao, biting lip, tears, eye contact with the partner or the viewer);
(5) foreplay, kissing, teasing; (6) aftermath, cuddling, dressing.
Skip talk-only, thought-only and memory paragraphs.

FOCUS OVER WIDE. Every shot has ONE subject - the exact place where the act happens - and the camera goes there:
- mouth on a nipple -> mouth, tongue and nipple fill the frame; a hand between legs -> the hand and what it touches; penetration -> the point of entry, both bodies cropped to it.
- name the subject so the model frames it: tags "nipple focus" / "crotch focus" / "penetration focus" / "hand focus" / "oral focus" / "ass focus" / "face focus", prose "tight close-up on ...".
- default distance: close-up or mid shot (upper body, lower body, from behind). A wide full-body shot ONLY for a position that needs the whole body to be read (a new position, standing sex, a lift, a leg lock) - at most one per reply, and even then name both contact points.
- a face shot is a legitimate subject: when the text dwells on how she or he looks in that moment (moaning, tearing up, eyes rolled back, looking at the partner), cut to the face - say whose face and what it does.
- always state the angle: from below, from above, from behind, from side, pov (first-person text, the viewer's hands / cock in frame), dutch angle.

ONE INSTANT, FEW PEOPLE. A shot is one frozen instant, never a sequence ("she undresses then rides him" is two shots). At most 2 people in the frame and at most 1 woman unless the text has several women in the SAME act at the SAME instant; anyone else is out of frame (say so: "partner out of frame, only his hands visible"). One camera, one subject, one moment.

POV LADDER. Pick the viewpoint from whose skin the text is written: (a) first-person narration or "you" -> pov, the viewer's own hands / cock / thighs cropped into the frame, the partner looking up or back at the viewer; (b) the text lives in one character's sensation -> the camera sits where that character's eyes are (from above when she is on top, from below when he is); (c) the narrator watches from outside -> from side / from behind / three-quarter view. Never swap the viewpoint mid-shot.

FRAME SCOPE. Say what is inside and what is outside the frame, and what hides what: feet out of frame, face out of frame, head cut off, hand covering mouth, hair over face, covered nipples (by hand / by hair / by his palm), breasts pressed against glass, body partly under the sheet, partner's back blocking the view. An occlusion is a real visual fact - tag it, do not describe what cannot be seen.

ANATOMY AND ACT, EXPLICIT. Use the real word for every organ and act - penis / cock, pussy / vagina, anus, nipples, clitoris, cum; never "her core", "his length", "intimate". Say who does what to whom with which part and how deep / how hard. Act vocabulary: sex, vaginal, anal, fellatio, deepthroat, irrumatio, cunnilingus, paizuri, handjob, fingering, grinding, kissing with tongue, french kiss, nipple sucking, breast grab, ass grab, spanking. Positions: missionary, doggystyle, cowgirl position, reverse cowgirl, prone bone, spooning, standing sex, suspended congress, full nelson, leg lock, mating press, spread legs, legs over shoulders, bent over, against wall, on lap, face to face.

MOTION IN A STILL - the picture must feel like a frame cut from a video, never a posed photo. Every shot carries 3-5 motion cues, chosen from what is moving in the text:
- the moving part: motion blur on hips / on hands / on hair, motion lines around the thrusting part, afterimage, speed lines, bouncing breasts, jiggling ass, swaying hair, flying hair strands, trembling legs, twitching, arched back mid-thrust, toes curling;
- what the motion throws off: sweat drops flying, sweat sheen, saliva trail, drool string, cum string, cum splash, squirting arc, tears mid-fall, flying droplets, water splash;
- what the body presses and pulls: sheets pulled taut, bed sheet grab, fingers digging into flesh, skin indentation, hair pull, thigh squeeze, pillow bite, headboard grip, wrinkled sheets;
- camera and frame: slight motion blur on the background, shallow depth of field, tilted frame, off-center subject, foreshortening, dynamic angle, frozen instant, mid-motion.
Write motion as a verb happening now (hips slamming, breasts bouncing, a drop of sweat mid-air) - never a state (she is sweaty). In prose one sentence per shot says what is in motion and what it flings, drips or pulls.
BODY PHYSICS BY POSE. Flesh follows gravity and pressure - pick the physics that the pose forces: on all fours / bent over -> hanging breasts, swaying breasts, ass up, back arched; lying on back -> breasts spread flat, spread legs, belly tensed; on top (cowgirl) -> bouncing breasts, bouncing ass, thighs quivering; pressed against a wall or glass -> breasts pressed flat, cheek squished, breath fog; lifted / standing -> legs wrapped, toes curled, thigh grip; from behind -> ass cheeks spread, skin indentation under a grip, imprint of fingers. Add blush spreading over chest, veins standing out on a forearm, sweat sheen where light hits.

CONTACT POINTS. Every touch, grip, mouth or entry is written as three parts - the body part, the verb, the placement: "right hand, gripping, her left hip"; "mouth, sucking, left nipple"; "cock, buried to the base, in her pussy"; "left hand, pinning, both wrists above her head". Two people touching = at least two contact points per shot; penetration always names the depth (tip, halfway, balls deep).

LIGHT WITH A DIRECTION. One light source, named with a direction and a colour, and where it lands on skin: warm lamp from the left throwing a rim on her hip, cold window light from behind (backlighting, silhouette edge on his shoulders), harsh overhead fluorescent flattening the shadows, screen glow from below, candle light flickering on wet skin. Shadows fall opposite the source; sweat and fluids catch the light (specular highlights on sweat, glossy cum).

FLUIDS. Name the fluid, where it is and how much: cum in pussy, cum on face, cum on breasts, cum on stomach, cumdrip, cum string, overflowing, saliva trail, drool, sweat drops, pussy juice / wet pussy, squirting, tears. Fluids from an earlier shot stay in later ones.
{{nsfw_tags}}
CLOTHING STATE. Never plain "naked" - say what is still on and how it moved: bra pushed up, panties pulled aside, panties around one ankle, shirt open, skirt lifted, torn stockings, one shoe on, unbuttoned, dress down to the waist, clothed male nude female (cmnf), bottomless. A stored $token outfit is still the token, plus the state (torn $mara.dress).

EXPRESSION UNDER SEX - the face is where the picture lives; a blank face turns the shot into a catalogue photo. For EVERY face in the frame (both people, not only hers) write 3-5 expression cues, built from four parts: GAZE (looking at partner / looking at viewer / eyes rolling back / looking back over shoulder / looking down at the point of entry / eyes shut tight), EYES (half-closed / wide-eyed / teary / cross-eyed / glazed / constricted pupils / narrowed), BROWS (furrowed / raised / knitted in pain / relaxed), MOUTH (open mouth moaning / biting lip / tongue out / gritted teeth / clenched jaw / screaming / smirk / kissing / panting / drooling), plus skin and head: heavy blush over cheeks and nose, sweat on the temple, hair stuck to the face, head thrown back, face buried in the pillow, cheek pressed into the sheet, chin lifted. Pick the cues from what the text says that person FEELS at this instant - overwhelmed pleasure (ahegao, torogao, fucked silly), pain or strain (knitted brows, gritted teeth, tears), shame (looking away, hand over mouth, flushed to the ears), dominance (smug, half-lidded stare down at her, grin), tenderness (soft eyes on the partner, forehead touch), fear or nervousness (wide eyes, trembling lip). The man reacts too: clenched jaw, furrowed brows, eyes locked on her, mouth open panting, teeth on her shoulder. Never a neutral, closed-mouth, model-like face unless the text says the person is composed. A face out of frame gets no cues - then say it is out of frame.

CONSISTENCY. Positions, penetration state, clothing state and fluids agree across the shots of one reply; the order of shots follows the order of the text.

CHECK BEFORE ANSWERING, every shot: one instant? <=2 people, <=1 woman? viewpoint chosen by the POV ladder and stated? region + distance + focus named? act and position named with real words? every touch a three-part contact point? physics matches the pose? fluids named with place and amount? clothing state per person, token kept? 3-5 expression cues for EVERY face in frame, his included, matching what that person feels? light source with a direction? 3-5 motion cues? frame scope / occlusion said? raw "prompt" keeps every $token and "final" writes each stored text out in full? Fix the shot before you reply, do not add a note.
`;
// Tags-dialect-only NSFW blocks (weights, tag order, density); prose gets nothing here.
const NSFW_TAG_RULES = `WEIGHTS (tags dialect only). Weight the ONE subject of the shot, its fluid and the main expression of the face in frame, nothing else: (nipple focus:1.2), (penetration:1.2), (cum in pussy:1.15), (ahegao:1.15) / (gritted teeth:1.1). At most 3 weighted tags per prompt, never above 1.3, never on a $token.

TAG ORDER (tags dialect). Denser than a SFW prompt: 45-70 tags, in this order - 1 rating + count; 2 camera (region, distance, viewpoint, focus); 3 the act and the position; 4 contact points (three tags each); 5 expression, 3-5 tags for EVERY face in frame (hers, then his); 6 body physics; 7 fluids; 8 clothing state per person ($token + state); 9 place, props and light direction; 10 motion cues; 11 frame scope / occlusion. Missing block = incomplete prompt.
`;

const NSFW_EXAMPLES = {
    tags: `EXAMPLES (tags dialect - three kinds of shot: contact close-up / wide position / face; raw "prompt" keeps $tokens, "final" writes each stored text out in full - shortened here for reading):
[
 {"p": 2, "ar": "landscape", "prompt": "close-up, nipple focus, from side, $tomas latches his mouth onto $mara's left nipple, tongue out licking the areola, saliva, breast grab, fingers sinking into soft flesh, $mara.bra pushed up above her breasts, arched back, hard nipples, motion lines around the sucking mouth, sweat drops on her chest, her hand gripping his hair, half-closed eyes, moaning, open mouth, warm bedside lamp light, shallow depth of field", "final": "close-up, nipple focus, from side, a broad-shouldered man with a short beard latches his mouth onto the left nipple of a petite freckled woman, tongue out licking the areola, saliva, breast grab, fingers sinking into soft flesh, black lace bra pushed up above her breasts, arched back, hard nipples, motion lines around the sucking mouth, sweat drops on her chest, her hand gripping his dark hair, her eyes half-closed, brows knitted, mouth open moaning, heavy blush, his eyes shut tight, brows furrowed, warm bedside lamp light, shallow depth of field"},
 {"p": 3, "ar": "landscape", "prompt": "wide shot, full body, doggystyle, from behind, $mara on all fours on rumpled white sheets, ass up, back arched, $tomas kneeling behind her gripping her hips, penetration, vaginal, sex from behind, motion blur on his hips, bouncing breasts, sweat drops flying, sheets pulled taut in her fists, $mara.panties around one ankle, her head turned back toward him, ahegao, tongue out, teary eyes, blush, his jaw clenched, teeth gritted, brows furrowed, eyes locked on her, morning light through blinds", "final": "wide shot, full body, doggystyle, from behind, a petite freckled woman on all fours on rumpled white sheets, ass up, back arched, a broad-shouldered bearded man kneeling behind her gripping her hips, penetration, vaginal, sex from behind, motion blur on his hips, bouncing breasts, sweat drops flying, sheets pulled taut in her fists, white cotton panties around one ankle, her head turned back toward him, ahegao, tongue out, teary eyes, blush, his jaw clenched, teeth gritted, brows furrowed, eyes locked on her, morning light through blinds"},
 {"p": 5, "ar": "portrait", "prompt": "close-up, face focus, from above, pov, $mara looking up at viewer, ahegao, eyes rolling back, tears in eyes, drool string from open mouth, flushed cheeks, cum on face, cum on tongue, cum string, messy hair stuck to sweaty forehead, trembling, harsh overhead light, shallow depth of field", "final": "close-up, face focus, from above, pov, a petite freckled woman with messy auburn hair looking up at viewer, ahegao, eyes rolling back, tears in eyes, drool string from open mouth, flushed cheeks, cum on face, cum on tongue, cum string, hair stuck to sweaty forehead, trembling, harsh overhead light, shallow depth of field"}
]
=====`,
    natural: `EXAMPLES (prose dialect - three kinds of shot: contact close-up / wide position / face; raw "prompt" keeps $tokens, "final" writes each stored text out in full - shortened here for reading):
[
 {"p": 2, "ar": "landscape", "prompt": "Tight close-up from the side, nipple focus: $tomas has his mouth clamped on $mara's left nipple, tongue out over the areola, a thread of saliva between his lips and her skin, his fingers sinking into the soft flesh of her breast. Her $mara.bra is pushed up above her breasts; her back arches into him, nipples hard, and her hand grips his hair. Motion lines ripple around his sucking mouth, sweat beads on her chest. Her eyes are half-closed, brows knitted, mouth open in a moan, a heavy blush across her cheeks; his eyes are shut tight and his brows furrowed with effort. Warm bedside lamp light, shallow depth of field.", "final": "Tight close-up from the side, nipple focus: a broad-shouldered man with a short beard has his mouth clamped on the left nipple of a petite freckled woman, tongue out over the areola, a thread of saliva between his lips and her skin, his fingers sinking into the soft flesh of her breast. Her black lace bra is pushed up above her breasts; her back arches into him, nipples hard, and her hand grips his dark hair. Motion lines ripple around his sucking mouth, sweat beads on her chest. Her eyes are half-closed, brows knitted, mouth open in a moan, a heavy blush across her cheeks; his eyes are shut tight and his brows furrowed with effort. Warm bedside lamp light, shallow depth of field."},
 {"p": 3, "ar": "landscape", "prompt": "Wide full-body shot from behind, doggystyle: $mara is on all fours on rumpled white sheets, ass raised and back arched, while $tomas kneels behind her gripping her hips and drives into her, vaginal penetration visible between their bodies. His hips are a motion blur, her breasts swing and bounce, sweat drops fly off his back, the sheets are pulled taut in her fists, her $mara.panties hang around one ankle. Her head is turned back toward him with an ahegao expression, tongue out, eyes teary, cheeks flushed; his jaw is clenched, teeth gritted, brows furrowed, eyes locked on her. Morning light through blinds.", "final": "Wide full-body shot from behind, doggystyle: a petite freckled woman is on all fours on rumpled white sheets, ass raised and back arched, while a broad-shouldered bearded man kneels behind her gripping her hips and drives into her, vaginal penetration visible between their bodies. His hips are a motion blur, her breasts swing and bounce, sweat drops fly off his back, the sheets are pulled taut in her fists, her white cotton panties hang around one ankle. Her head is turned back toward him with an ahegao expression, tongue out, eyes teary, cheeks flushed; his jaw is clenched, teeth gritted, brows furrowed, eyes locked on her. Morning light through blinds."},
 {"p": 5, "ar": "portrait", "prompt": "Close-up on $mara's face from above, POV: she looks up at the viewer with an ahegao expression, eyes rolling back, tears at the corners, a string of drool from her open mouth, cheeks flushed. Cum streaks her cheek and pools on her tongue, one strand still stretching. Messy hair sticks to her sweaty forehead and she trembles. Harsh overhead light, shallow depth of field.", "final": "Close-up on the face of a petite freckled woman with messy auburn hair, from above, POV: she looks up at the viewer with an ahegao expression, eyes rolling back, tears at the corners, a string of drool from her open mouth, cheeks flushed. Cum streaks her cheek and pools on her tongue, one strand still stretching. Hair sticks to her sweaty forehead and she trembles. Harsh overhead light, shallow depth of field."}
]`,
};

export const SCENE_DOC_RULES = `

SCENE DOCUMENT RULES (a SCENE DOCUMENT is given - these rules override anything above that conflicts):
- The document is the source of truth for this reply. The paragraph only picks the MOMENT and the CAMERA; where it happens, who is present, what they wear, how they feel and where they are positioned all come from the document. TRANSLATE the document into the prompt - never summarise the paragraph alone.
- EVERY prompt must contain, explicitly:
  (a) WHERE: indoors/outdoors and the place type from LOCATION, the furniture and props from LAYOUT that would be in the frame and where they stand (bed against the wall, lit lamp on the nightstand, rain on the window...), time of day and the lighting.
  (b) for EACH person present in that shot: their $keyword, then their clothing written out in words from that person's WEARING lines with colours and state (never just "clothes" or "dressed" - write e.g. "unbuttoned white linen shirt, black cotton shorts, barefoot"), their EXPRESSION and gaze, the action of that paragraph from DOING with its points of contact, and their POSE / POSITION relative to the furniture and to the other people (sitting on the left edge of the bed, kneeling at his feet, facing away from the viewer).
- Clothing comes from the document's WEARING lines. When a WEARING line is a token ($yen.outfit_work, $seb.normal_shirt) keep that token in the raw "prompt" (plus the state words that follow it) and write its stored text, trimmed to what is visible, in the "final". When the line is written in words, copy the words into both. Other tokens ($keyword.back, .nsfw, .body, places like $seb.apartment) work the same way.
- The document may open with a TOKENS section that defines new tokens ($seb.npc_william: ..., $seb.outfit_work: ...). Treat them exactly like roster entries: token in the raw "prompt", their text in the "final".
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
        id: 'nsfw_explicit', builtin: true, name: 'NSFW explicit', nsfw: true,
        system: ROLE + NSFW_RULES + OUTPUT_RULES,
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
        .replaceAll('{{example}}', preset.nsfw ? (NSFW_EXAMPLES[dialect] ?? NSFW_EXAMPLES.tags) : doc ? '' : EXAMPLES[dialect])
        .replaceAll('{{doc_example}}', DOC_EXAMPLES[dialect])
        .replaceAll('{{nsfw_tags}}', dialect === 'tags' ? NSFW_TAG_RULES : '');
    const paraBlock = a.paragraphs.map(p => `[${p.index}] ${p.text}`).join('\n\n');
    const what = doc
        ? 'translate the SCENE DOCUMENT into the prompt of each (place + props from LAYOUT, lighting, and for every person present: clothing in words with colours and state, expression, the action of that paragraph, pose / position)'
        : 'describe the SCENE of each (actions, poses, setting, lighting, camera)';
    const ask = a.fixed
        ? `Write one prompt for EACH of the ${a.count} paragraph(s) listed (use every listed "p" exactly once), ${what}, and reply with the JSON array only.`
        : `Choose ${a.count} paragraph(s), ${what}, and reply with the JSON array only.`;
    const user = [
        a.roster ? `ROSTER (keyword -> who they are, base look, stored entries as $keyword.key: text. In the raw "prompt" use the tokens; in the "final" write every base look and entry text out IN FULL, word for word):\n${a.roster}` : 'ROSTER: (none)',
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
        // String fields: each value runs from its opening quote to the next `", "<key>":` boundary or to the end of the chunk.
        const heads = [...raw.matchAll(/"(prompt|final|text|scene|ar)"\s*:\s*"/g)];
        heads.forEach((h, k) => {
            const from = h.index + h[0].length;
            let v = raw.slice(from, heads[k + 1] ? heads[k + 1].index : raw.length);
            v = v.replace(/"\s*,\s*$/, '');
            const q = v.lastIndexOf('"');
            if (q >= 0 && q === v.length - 1) v = v.slice(0, q);
            if (v.endsWith('\\')) v = v.slice(0, -1);
            obj[h[1]] = v.replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
        });
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

/**
 * Parse the step-2 reply into [{ p, prompt, final?, ar? }] restricted to valid paragraph numbers.
 * `final` is the smooth version without tokens; it is dropped when the model left a $token in it (the compiler would
 * have nothing to resolve it against and the image model would read a bare "$yen").
 */
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
        if (final && !/\$[\p{L}_]/u.test(final)) o.final = final;
        if (['portrait', 'landscape', 'square'].includes(ar)) o.ar = ar;
        out.push(o);
    }
    return out.sort((x, y) => x.p - y.p);
}
