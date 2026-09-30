import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DeviceStreamPlayer } from "#next/components/device/stream-player";
import { Button } from "#next/ui/button";
import type { LocalDeviceInfo } from "#shared/contracts";

import { useSessionsTransport } from "../data/queries";
export const DeviceTab = ({ visible }: { visible: boolean }) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const devices = useQuery(
    transport.orpc.devices.list.queryOptions({ input: {} })
  );
  const [device, setDevice] = useState<LocalDeviceInfo | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!device || !visible) return;
    const abort = new AbortController();
    let streamId: number | undefined;
    let player: DeviceStreamPlayer | undefined;
    let media: MediaStream | undefined;
    const fallback = async () => {
      if (device.platform !== "ios") return;
      const source = await transport.client.devices.simulatorWindowSource({
        deviceName: device.name,
      });
      if (!source.sourceId)
        throw new Error(source.error ?? t("sessions.device.permission"));
      media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: source.sourceId,
          },
        } as MediaTrackConstraints,
      });
      if (abort.signal.aborted) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      if (video.current) {
        video.current.srcObject = media;
        await video.current.play();
      }
    };
    void (async () => {
      try {
        const start = await transport.client.devices.stream.start({
          platform: device.platform,
          deviceId: device.id,
        });
        streamId = start.streamId;
        if (abort.signal.aborted) return;
        if (!start.success || streamId === undefined)
          throw new Error(start.error ?? "Device stream unavailable");
        player = new DeviceStreamPlayer(canvas.current!, (e) =>
          setError(String(e))
        );
        for await (const chunk of await transport.client.devices.stream.chunks(
          { streamId },
          { signal: abort.signal }
        )) {
          if (abort.signal.aborted) break;
          await player.push(chunk);
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(String(e));
          void fallback().catch((e) => setError(String(e)));
        }
      } finally {
        if (streamId !== undefined)
          void transport.client.devices.stream.stop({ streamId });
      }
    })();
    return () => {
      abort.abort();
      player?.dispose();
      media?.getTracks().forEach((track) => track.stop());
      if (streamId !== undefined)
        void transport.client.devices.stream.stop({ streamId });
    };
  }, [device, visible, transport, t]);
  return (
    <div className="flex size-full flex-col gap-2 p-3">
      <div className="flex gap-2">
        {devices.data?.map((d) => (
          <Button
            key={d.id}
            variant="outline"
            onClick={() => {
              setError(null);
              setDevice(d);
              if (d.state !== "booted")
                void transport.client.devices.boot({
                  platform: d.platform,
                  deviceId: d.id,
                  focus: true,
                });
            }}
          >
            {d.name}
          </Button>
        ))}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {!device ? <p>{t("sessions.device.empty")}</p> : null}
      <canvas
        ref={canvas}
        className="min-h-0 max-w-full flex-1 object-contain"
        tabIndex={0}
        aria-label={t("sessions.device.screen")}
        onPointerDown={(e) => {
          if (!device) return;
          const rect = e.currentTarget.getBoundingClientRect();
          void transport.client.devices.stream.touch({
            platform: device.platform,
            deviceId: device.id,
            phase: "tap",
            x: ((e.clientX - rect.left) * e.currentTarget.width) / rect.width,
            y: ((e.clientY - rect.top) * e.currentTarget.height) / rect.height,
            deviceWidth: e.currentTarget.width,
            deviceHeight: e.currentTarget.height,
          });
        }}
      />
      <video ref={video} muted className="max-h-full object-contain" />
    </div>
  );
};
