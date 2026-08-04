# Brand source art

`matchbook-wordmark-source.png` — the wordmark as delivered, on its cream
paper. Kept because the served asset is cut from it and cannot be reversed.

The served file, `app/public/images/matchbook-wordmark.png`, is made by taking
each pixel's distance from the paper colour as its alpha, rather than by flood
filling the background out. Flood fill leaves a cream fringe on every
antialiased letter edge, which shows as soon as the mark is put on anything but
cream; a distance mask gives the edge partial alpha instead, so it composites
cleanly on any ground.

    magick matchbook-wordmark-source.png \
      \( +clone -fill 'srgb(249,243,228)' -colorize 100 \) \
      -compose Difference -composite \
      -colorspace Gray -level 18%,42% \
      -morphology Open Disk:2 \
      mask.png

    magick matchbook-wordmark-source.png mask.png -alpha off \
      -compose CopyOpacity -composite -trim +repage \
      -resize x200 -strip -colors 96 \
      ../app/public/images/matchbook-wordmark.png

The 18%/42% levels are measured, not guessed: the paper grain's distance from
the base colour tops out at 15.7% and the ink's runs to 61%, so the cut sits
between them. `Open Disk:2` clears isolated grain specks that would otherwise
survive and inflate the trim box.

## Card illustrations

`motif-sources/*.png` — the topic illustrations as delivered, on their chroma
green. Kept for the same reason as the wordmark: the served files are cut from
them and the cut cannot be reversed.

The served files are `app/public/images/motifs/<topic>.png`, one per topic key
in `imports/ui/utilities/topics.js`. Cut the same way as the wordmark — alpha
from each pixel's distance to the key colour — because a flood fill leaves a
green rim on every antialiased edge and these sit on pale pastel fields where
that shows immediately.

    magick source.png \
      \( +clone -fill 'srgb(3,239,7)' -colorize 100 \) \
      -compose Difference -composite \
      -colorspace Gray -level 8%,20% mask.png

    magick source.png mask.png -compose CopyOpacity -composite \
      -resize 320x320 ../app/public/images/motifs/<topic>.png

The 8%/20% levels are measured: the chroma background sits under 1% from the key
and the artwork starts at 26%, so the cut sits between them.

Three traps, all of which produced a black silhouette or a flat grey file before
they were found:

  * `-alpha off` before `-compose CopyOpacity` discards the source's colour.
  * ImageMagick infers the output type from the LAST image in the sequence, and
    the mask is grayscale — so the PNG is written as gray+alpha unless the
    colour survives to the write. Check with `identify -format %[channels]`;
    it must say `srgba`.
  * `-background none -gravity center -extent` after the composite blackens the
    RGB. The sources are already square with even margins, so neither `-trim`
    nor `-extent` is needed.

`running-spare.png` is a ninth illustration with no topic of its own — a runner,
an alternative to the mountain for Move & Explore. Swap the `icon:` path in
topics.js to use it.
