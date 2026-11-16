import { createCanvas } from '@napi-rs/canvas';

const W = 1920;
const H = 1080;

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function fmtTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return hh > 0 ? `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function fmtPace(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return '--:--';
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createHudRenderer() {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: true });
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  return {
    width: W,
    height: H,
    render(metrics, videoTimeMs, activityOffsetMs = 0) {
      // Clear to fully transparent every frame.
      ctx.clearRect(0, 0, W, H);

      const x = 72, y = 72, panelW = 590, panelH = 250;
      ctx.save();
      roundedRect(ctx, x, y, panelW, panelH, 28);
      ctx.fillStyle = 'rgba(8, 14, 24, 0.76)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.20)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#A8B7C9';
      ctx.font = '600 22px Arial';
      ctx.fillText('RUNNING DATA', x + 34, y + 38);

      // Pace
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 76px Arial';
      ctx.fillText(fmtPace(metrics.pace_sec_km), x + 34, y + 126);
      ctx.fillStyle = '#A8B7C9';
      ctx.font = '500 22px Arial';
      ctx.fillText('MIN / KM', x + 36, y + 184);

      // Heart rate
      ctx.fillStyle = '#FF667D';
      ctx.font = '700 54px Arial';
      ctx.fillText(Number.isFinite(metrics.heart_rate) ? `${Math.round(metrics.heart_rate)}` : '--', x + 330, y + 122);
      ctx.fillStyle = '#A8B7C9';
      ctx.font = '500 22px Arial';
      ctx.fillText('♥  BPM', x + 333, y + 184);

      // Distance and elapsed time at bottom right
      const distance = Number.isFinite(metrics.distance_km) ? metrics.distance_km.toFixed(2) : '--';
      const elapsed = fmtTime(videoTimeMs + activityOffsetMs);
      const bx = W - 470, by = H - 190, bw = 398, bh = 118;
      roundedRect(ctx, bx, by, bw, bh, 24);
      ctx.fillStyle = 'rgba(8, 14, 24, 0.76)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.20)';
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 48px Arial';
      ctx.fillText(`${distance} km`, bx + 26, by + 43);
      ctx.fillStyle = '#A8B7C9';
      ctx.font = '500 25px Arial';
      ctx.fillText(elapsed, bx + 27, by + 85);
      ctx.restore();

      return ctx.getImageData(0, 0, W, H).data;
    }
  };
}
