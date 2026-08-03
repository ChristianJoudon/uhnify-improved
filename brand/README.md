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
