import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { devicePoint, simulatorCrop } from "#renderer/components/device/crop";
import { DeviceStreamPlayer } from "#renderer/components/device/stream-player";
import { EmptyState } from "#renderer/components/empty-state";
import type { Transport } from "#renderer/data/transport";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";
import type { LocalDeviceInfo } from "#shared/contracts";

import { useSessionsTransport } from "../data/queries";

const startDeviceCapture = (
  device: LocalDeviceInfo,
  transport: Transport,
  frame: HTMLCanvasElement,
  denied: RefObject<Set<string>>,
  setError: (error: string | null) => void,
  setPermission: (permission: boolean) => void,
  t: TFunction
) => {
  const abort = new AbortController();
  const streamAbort = new AbortController();
  let streamId: number | undefined;
  let player: DeviceStreamPlayer | undefined;
  let media: MediaStream | undefined;
  let animation = 0;
  let fallbackStarted = false;
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      abort.signal.addEventListener("abort", done, { once: true });
    });
  const paintScreenshot = async () => {
    const shot = await transport.client.devices.screenshot({
      platform: device.platform,
      deviceId: device.id,
    });
    if (!shot.dataUrl)
      throw new Error(shot.error ?? t("sessions.device.unavailable"));
    const image = new Image();
    image.src = shot.dataUrl;
    await image.decode();
    if (!abort.signal.aborted) {
      frame.width = image.naturalWidth;
      frame.height = image.naturalHeight;
      frame.getContext("2d")?.drawImage(image, 0, 0);
    }
    return image.naturalWidth / image.naturalHeight;
  };
  const snapshots = async () => {
    while (!abort.signal.aborted) {
      try {
        await paintScreenshot();
      } catch (e) {
        if (!abort.signal.aborted) setError(String(e));
      }
      await pause(1000);
    }
  };
  const fallback = async (reason: unknown) => {
    if (fallbackStarted || abort.signal.aborted) return;
    fallbackStarted = true;
    streamAbort.abort();
    player?.dispose();
    setError(String(reason));
    if (streamId !== undefined)
      await transport.client.devices.stream.stop({ streamId }).catch(() => {});
    streamId = undefined;
    if (device.platform === "ios") {
      try {
        await transport.client.devices.boot({
          platform: device.platform,
          deviceId: device.id,
          focus: false,
        });
        if (denied.current.has(device.id))
          throw new Error(t("sessions.device.permission"));
        const aspect = await paintScreenshot().catch(() => null);
        for (let attempt = 0; ; attempt++) {
          const source = await transport.client.devices.simulatorWindowSource({
            deviceName: device.name,
          });
          if (
            source.screenPermission &&
            source.screenPermission !== "granted"
          ) {
            denied.current.add(device.id);
            setPermission(true);
            throw new Error(t("sessions.device.permission"));
          }
          if (source.sourceId) {
            media = await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: {
                mandatory: {
                  chromeMediaSource: "desktop",
                  chromeMediaSourceId: source.sourceId,
                  maxFrameRate: 60,
                },
              } as MediaTrackConstraints,
            });
            break;
          }
          if (attempt >= 3 || abort.signal.aborted)
            throw new Error(source.error ?? t("sessions.device.unavailable"));
          await pause(800);
        }
        if (abort.signal.aborted) {
          media?.getTracks().forEach((track) => track.stop());
          return;
        }
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = media!;
        await video.play();
        const draw = () => {
          if (abort.signal.aborted) return;
          const crop = simulatorCrop(
            video.videoWidth,
            video.videoHeight,
            aspect
          );
          if (crop.width && crop.height) {
            if (frame.width !== crop.width || frame.height !== crop.height) {
              frame.width = crop.width;
              frame.height = crop.height;
            }
            frame
              .getContext("2d")
              ?.drawImage(
                video,
                crop.x,
                crop.y,
                crop.width,
                crop.height,
                0,
                0,
                crop.width,
                crop.height
              );
          }
          animation = requestAnimationFrame(draw);
        };
        draw();
        setError(null);
        return;
      } catch (e) {
        media?.getTracks().forEach((track) => track.stop());
        if (!abort.signal.aborted) setError(String(e));
      }
    }
    await snapshots();
  };
  void (async () => {
    try {
      const start = await transport.client.devices.stream.start({
        platform: device.platform,
        deviceId: device.id,
      });
      streamId = start.streamId;
      if (!start.success || streamId === undefined)
        throw new Error(start.error ?? t("sessions.device.unavailable"));
      if (abort.signal.aborted) {
        await transport.client.devices.stream.stop({ streamId });
        return;
      }
      player = new DeviceStreamPlayer(frame, (e) => void fallback(e));
      for (let failures = 0; !abort.signal.aborted && !fallbackStarted;) {
        try {
          player.resetBarrier();
          for await (const chunk of await transport.client.devices.stream.chunks(
            { streamId },
            { signal: streamAbort.signal }
          )) {
            if (abort.signal.aborted || fallbackStarted) break;
            if (chunk.streamId === streamId) await player.push(chunk);
          }
          if (!abort.signal.aborted && !fallbackStarted)
            throw new Error("Device stream ended");
        } catch (e) {
          if (abort.signal.aborted || fallbackStarted) break;
          if (++failures > 3) throw e;
          await pause(250);
        }
      }
    } catch (e) {
      await fallback(e);
    }
  })();
  return () => {
    abort.abort();
    streamAbort.abort();
    player?.dispose();
    cancelAnimationFrame(animation);
    media?.getTracks().forEach((track) => track.stop());
    if (streamId !== undefined)
      void transport.client.devices.stream.stop({ streamId });
  };
};

export const DeviceTab = ({ visible }: { visible: boolean }) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const devices = useQuery({
    ...transport.orpc.devices.list.queryOptions({ input: {} }),
    refetchInterval: 10000,
  });
  const [device, setDevice] = useState<LocalDeviceInfo | null>(null);
  const [active, setActive] = useState(visible);
  const [retry, setRetry] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState(false);
  const denied = useRef(new Set<string>());
  const [text, setText] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setActive(visible), visible ? 0 : 10000);
    return () => clearTimeout(timer);
  }, [visible]);
  useEffect(() => {
    if (!device || !active) return;
    return startDeviceCapture(
      device,
      transport,
      canvas.current!,
      denied,
      setError,
      setPermission,
      t
    );
  }, [device, active, retry, transport, t]);
  const action = (promise: Promise<unknown>) =>
    void promise.catch((e) => setError(String(e)));
  const touch = (
    e: React.PointerEvent<HTMLCanvasElement>,
    phase: "down" | "move" | "up"
  ) => {
    if (!device || (phase === "move" && !e.buttons)) return;
    if (phase === "down") e.currentTarget.setPointerCapture(e.pointerId);
    const point = devicePoint(
      e.clientX,
      e.clientY,
      e.currentTarget.getBoundingClientRect(),
      e.currentTarget.width,
      e.currentTarget.height
    );
    action(
      transport.client.devices.stream.touch({
        platform: device.platform,
        deviceId: device.id,
        phase,
        ...point,
        deviceWidth: e.currentTarget.width,
        deviceHeight: e.currentTarget.height,
      })
    );
  };
  return (
    <div className="flex size-full min-h-0 flex-col gap-2 p-3">
      <div className="flex flex-wrap gap-2">
        {devices.data?.map((d) => (
          <Button
            key={d.id}
            variant={device?.id === d.id ? "secondary" : "outline"}
            onClick={() => {
              setError(null);
              setPermission(false);
              setDevice(d);
              if (d.state !== "booted")
                action(
                  transport.client.devices.boot({
                    platform: d.platform,
                    deviceId: d.id,
                    focus: true,
                  })
                );
            }}
          >
            {d.name}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void devices.refetch()}
        >
          {t("sessions.device.refresh")}
        </Button>
        {device ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                action(
                  transport.client.devices.boot({
                    platform: device.platform,
                    deviceId: device.id,
                    focus: true,
                  })
                )
              }
            >
              {t("sessions.device.open")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                action(
                  transport.client.devices.buildAndRun({
                    platform: device.platform,
                    deviceId: device.id,
                  })
                )
              }
            >
              {t("sessions.device.build")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                action(
                  transport.client.devices.interact({
                    platform: device.platform,
                    deviceId: device.id,
                    action: "press_key",
                    key: "HOME",
                  })
                )
              }
            >
              {t("sessions.device.home")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                denied.current.delete(device.id);
                setPermission(false);
                setError(null);
                setRetry((n) => n + 1);
              }}
            >
              {t("sessions.common.retry")}
            </Button>
          </>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {permission ? (
        <Button
          onClick={() =>
            action(
              transport.client.system.openPrivacyPane({
                pane: "screen-recording",
              })
            )
          }
        >
          {t("sessions.device.grant")}
        </Button>
      ) : null}
      {!device ? (
        <EmptyState
          title={t("sessions.device.empty")}
          className="my-auto [&_[data-slot=empty-title]]:text-sm"
          action={
            <Button
              size="sm"
              variant="secondary"
              nativeButton={false}
              render={<AppLink to="/settings/devices" />}
            >
              {t("settings.pages.devices")}
            </Button>
          }
        />
      ) : null}
      <canvas
        ref={canvas}
        className={
          device
            ? "min-h-0 max-w-full flex-1 touch-none object-contain"
            : "hidden"
        }
        tabIndex={0}
        aria-label={t("sessions.device.screen")}
        onPointerDown={(e) => touch(e, "down")}
        onPointerMove={(e) => touch(e, "move")}
        onPointerUp={(e) => touch(e, "up")}
        onKeyDown={(e) => {
          if (!device) return;
          e.preventDefault();
          action(
            transport.client.devices.stream.key({
              platform: device.platform,
              deviceId: device.id,
              code: e.code,
              key: e.key,
              shift: e.shiftKey,
              ctrl: e.ctrlKey,
              alt: e.altKey,
              meta: e.metaKey,
            })
          );
        }}
      />
      {device ? (
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            action(
              transport.client.devices.interact({
                platform: device.platform,
                deviceId: device.id,
                action: "type",
                text,
              })
            );
            setText("");
          }}
        >
          <Input
            aria-label={t("sessions.device.type")}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" disabled={!text}>
            {t("sessions.device.send")}
          </Button>
        </form>
      ) : null}
    </div>
  );
};
