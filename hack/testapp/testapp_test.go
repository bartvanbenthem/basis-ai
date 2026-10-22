package main

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func pngOf(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w/2; x++ { // left half red
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{220, 30, 30, 255})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func TestPrepareScalesDown(t *testing.T) {
	p, err := Prepare(pngOf(3000, 1500))
	if err != nil {
		t.Fatal(err)
	}
	if p.Width != displaySize || p.Height != displaySize/2 {
		t.Errorf("display %dx%d", p.Width, p.Height)
	}
	thumb, _ := jpeg.Decode(bytes.NewReader(p.Thumb))
	if b := thumb.Bounds(); b.Dx() != thumbSize || b.Dy() != thumbSize/2 {
		t.Errorf("thumb %v", b)
	}
	if _, err := Prepare([]byte("not an image")); err == nil {
		t.Error("garbage accepted")
	}
	small, _ := Prepare(pngOf(200, 100))
	if small.Width != 200 {
		t.Errorf("a small image is scaled up: %d", small.Width)
	}
}

// jpegWithOrientation is a JPEG with an EXIF APP1 segment carrying the orientation.
func jpegWithOrientation(o uint16, w, h int) []byte {
	var img bytes.Buffer
	_ = jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, w, h)), nil)
	tiff := []byte("II*\x00\x08\x00\x00\x00\x01\x00") // little endian, IFD at 8, one entry
	entry := make([]byte, 12)
	binary.LittleEndian.PutUint16(entry[0:], 0x0112) // orientation
	binary.LittleEndian.PutUint16(entry[2:], 3)      // SHORT
	binary.LittleEndian.PutUint32(entry[4:], 1)
	binary.LittleEndian.PutUint16(entry[8:], o)
	payload := append(append([]byte("Exif\x00\x00"), tiff...), append(entry, 0, 0, 0, 0)...)
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	b := img.Bytes()
	return append(append(append([]byte{}, b[:2]...), append(seg, payload...)...), b[2:]...)
}

func TestExifOrientation(t *testing.T) {
	raw := jpegWithOrientation(6, 40, 20)
	if o := exifOrientation(raw); o != 6 {
		t.Fatalf("orientation %d", o)
	}
	p, err := Prepare(raw)
	if err != nil {
		t.Fatal(err)
	}
	if p.Width != 20 || p.Height != 40 {
		t.Errorf("rotated photo is %dx%d, want 20x40", p.Width, p.Height)
	}
	if o := exifOrientation(pngOf(4, 4)); o != 1 {
		t.Errorf("png orientation %d", o)
	}
}

func TestParseDescription(t *testing.T) {
	d, err := parseDescription("Here you go:\n```json\n{\"title\": \"Dog on a beach\", \"caption\": \"A brown dog runs.\", \"tags\": [\"Dog\", \"beach \", \"dog\", \"\"]}\n```")
	if err != nil {
		t.Fatal(err)
	}
	if d.Title != "Dog on a beach" || len(d.Tags) != 2 || d.Tags[0] != "dog" || d.Tags[1] != "beach" {
		t.Errorf("%+v", d)
	}
	if _, err := parseDescription("I can't see an image."); err == nil {
		t.Error("no JSON accepted")
	}
}

func TestCacheKeys(t *testing.T) {
	if key("p:", "v1", normalize("Dog on a beach?")) != key("p:", "v1", normalize("  dog ON a   beach ")) {
		t.Error("normalized queries differ")
	}
	if key("p:", libTag(1), "q") == key("p:", libTag(2), "q") {
		t.Error("a new library version must change the key")
	}
	v := []float32{1, -2.5, 0.125}
	if got := fromBytes([]byte(vecBytes(v))); len(got) != 3 || got[1] != -2.5 || got[2] != 0.125 {
		t.Errorf("round trip %v", got)
	}
}

func TestVectorText(t *testing.T) {
	s := vectorText([]float32{0.5, -1, 1e-7})
	if s != "[0.5,-1,1e-07]" {
		t.Errorf("%s", s)
	}
	v, err := parseVector(s)
	if err != nil || len(v) != 3 || v[2] != 1e-7 {
		t.Errorf("%v %v", v, err)
	}
}
