package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/jpeg"

	_ "image/gif" // decoders for uploads
	_ "image/png"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// Sizes a photo is kept in: one to show, one to list. The models get the
// display size; larger costs tokens and time without finding more.
const (
	displaySize = 1280
	thumbSize   = 480
)

// Prepared is an upload made ready to store and send to the models.
type Prepared struct {
	Display, Thumb []byte // JPEG
	Width, Height  int    // of Display
}

// Prepare decodes an upload (JPEG, PNG, GIF, WebP), turns it upright as
// the camera's EXIF says, and scales it down to the display and thumbnail
// sizes.
func Prepare(raw []byte) (*Prepared, error) {
	img, format, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("not an image this app reads (JPEG, PNG, GIF, WebP): %w", err)
	}
	if format == "jpeg" {
		img = orient(img, exifOrientation(raw))
	}
	display := fit(img, displaySize)
	p := &Prepared{Width: display.Bounds().Dx(), Height: display.Bounds().Dy()}
	if p.Display, err = encode(display, 85); err != nil {
		return nil, err
	}
	if p.Thumb, err = encode(fit(display, thumbSize), 80); err != nil {
		return nil, err
	}
	return p, nil
}

// fit scales img down so its longer side is at most max.
func fit(img image.Image, max int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= max && h <= max {
		return img
	}
	if w >= h {
		w, h = max, h*max/w
	} else {
		w, h = w*max/h, max
	}
	dst := image.NewRGBA(image.Rect(0, 0, max1(w), max1(h)))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	return dst
}

func max1(v int) int {
	if v < 1 {
		return 1
	}
	return v
}

func encode(img image.Image, quality int) ([]byte, error) {
	var buf bytes.Buffer
	err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality})
	return buf.Bytes(), err
}

// exifOrientation reads the orientation tag (1-8) of a JPEG's EXIF, 1 when
// there is none: phones store photos sideways and say so there.
func exifOrientation(b []byte) int {
	if len(b) < 4 || b[0] != 0xFF || b[1] != 0xD8 {
		return 1
	}
	for i := 2; i+4 <= len(b); {
		if b[i] != 0xFF {
			return 1
		}
		marker, size := b[i+1], int(binary.BigEndian.Uint16(b[i+2:]))
		if marker == 0xDA || size < 2 || i+2+size > len(b) { // image data: no EXIF before it
			return 1
		}
		seg := b[i+4 : i+2+size]
		if marker == 0xE1 && len(seg) > 14 && string(seg[:6]) == "Exif\x00\x00" {
			return tiffOrientation(seg[6:])
		}
		i += 2 + size
	}
	return 1
}

func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	ifd := int(order.Uint32(t[4:]))
	if ifd+2 > len(t) {
		return 1
	}
	n := int(order.Uint16(t[ifd:]))
	for e := 0; e < n; e++ {
		p := ifd + 2 + 12*e
		if p+12 > len(t) {
			return 1
		}
		if order.Uint16(t[p:]) == 0x0112 {
			if v := int(order.Uint16(t[p+8:])); v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}

// orient applies an EXIF orientation: mirror and/or rotate to upright.
func orient(img image.Image, o int) image.Image {
	if o <= 1 || o > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	swap := o >= 5
	dw, dh := w, h
	if swap {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch o {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			dst.Set(dx, dy, img.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return dst
}
