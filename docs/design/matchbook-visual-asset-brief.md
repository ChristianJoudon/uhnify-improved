# MatchBook visual asset brief

MatchBook's recognizable visual language is a small set of flat, friendly
editorial illustrations: warm cream, tangerine, charcoal, and one quiet topic
colour. Event and group surfaces inherit that topic art until an organizer
uploads a real photo. We do not need another library of generic stock images.

## Make these first

### 0. Re-export the complete motif set with clean transparency

- The current production PNGs carry a thin bright-green fringe in partially
  transparent edge pixels from their original background removal. It is most
  visible around the Community and Family & Wellbeing marks on their pastel
  fields.
- Re-export every motif from its clean source, or remove the green matte before
  delivery. Do not erase only the fully green pixels; the antialiased edge must
  be composited against transparency correctly.
- This applies to all files in `/images/motifs/`, including the five concepts
  that otherwise stay the same.

### 1. Community & Causes topic mark — replace the dice/table image

- Meaning: neighbors showing up, volunteering, civic life, service, and causes.
- Direction: a small circle of hands, a shared lei, or people building/holding
  one simple community object. It should read as community before it reads as a
  game.
- Avoid: dice, chess pieces, a board-game table, political-party symbols, and
  institutional seals.
- Runtime target: `/images/motifs/community.png`.

### 2. Support Groups topic mark — new, distinct asset

- Meaning: a private, welcoming peer circle where people feel understood.
- Direction: three supportive speech/people shapes around a calm open center,
  or two hands sheltering a small warm light.
- Avoid: medical crosses, diagnoses, recovery-program logos, pills, alcohol,
  identifiable people, and anything that implies a person's condition.
- Runtime target: new `/images/motifs/support.png`.

### 3. Family & Wellbeing topic mark — replace the plant/home holdover

- Meaning: keiki, family time, parenting, kupuna, everyday wellbeing, and care.
- Direction: an inclusive small-and-large pair under a sun, or several
  different-sized shapes connected by one warm arc.
- Avoid: a gendered nuclear-family silhouette, a house/real-estate mark, and a
  plant-only image. The current plant mark belongs to the retired “Plants &
  Home” concept rather than this category.
- Runtime target: `/images/motifs/wellness.png`.

### 4. Nights Out topic mark — replace the cup-and-fork image

- Meaning: social evenings, trivia, festivals, celebrations, and going out.
- Direction: string lights with a star/spark, a moon over two social shapes, or
  a small marquee with confetti.
- Avoid: making it read as a second Food & Markets category; food and alcohol
  should not be the main symbol.
- Runtime target: `/images/motifs/night.png`.

## Keep, with a consistency polish only

- Move & Explore — mountain and trail.
- Music & Performance — drum and note.
- Books & Ideas — open book.
- Food & Markets — market bag.
- Make & Create — hand and brush.

If these are redrawn alongside the four priority marks, preserve their concepts
and only normalize proportions, charcoal weight, cream highlights, and the
tangerine area so all nine feel made by one illustrator.

## Organizer-provided image templates

These are not defaults. They are guides for real organizers who claim a
listing and choose to add media.

1. **Event photo guide** — 1600 × 1200 px, 4:3, JPG or WebP, under 2 MB. Keep
   the subject in the center 70%; the interface crops the edges at different
   widths. No event title burned into the image.
2. **Group photo/logo guide** — 1200 × 1200 px, square PNG/JPG/WebP, under 2 MB.
   Keep the important mark inside an 80% safe area. A transparent logo should
   include enough cream/white separation to work on the topic field.

Until one of those real uploads exists, the product now deliberately uses the
topic's colour and mark instead of legacy stock artwork.

## Delivery specification for every topic mark

- Transparent PNG, 640 × 640 px, sRGB.
- No text, border, card background, shadow baked into the file, or rounded
  square container.
- Keep all artwork inside a 12% safe margin.
- Core palette: tangerine `#EB6219`, charcoal `#303234`, warm cream around
  `#F6E8D6`; one topic tint may be added sparingly.
- Broad, hand-cut shapes rather than thin line icons; recognizable at 56 px.
- One consistent light source and silhouette weight across the full set.

## Assets we should retire, not remake

The eight 800 × 1000 legacy category posters in `/images/topics/` contain their
own type and illustration style. They are no longer the default event/group
back and should not be replaced with another set of stock posters. Live type,
topic colour, and the transparent topic mark are the more flexible system.

## Interface icon note

The center Match control now uses a standard reverse/flip symbol between Pass
and Save, so it does not require custom artwork. If a custom interaction set is
commissioned later, deliver one cohesive 24 px SVG family for Pass, Show
details, Show front, Save, and Undo rather than redrawing only one symbol.
