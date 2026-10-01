// User-login credentials and file manifests remain in private scratch storage.
export function validatePerfProducer(producer) {
  if (
    producer?.kind !== "perf" ||
    producer.status !== "complete" ||
    !producer.fixture ||
    !producer.files ||
    producer.gaps?.length
  )
    return false;
  if (producer.provenance === "user-login")
    return (
      producer.sourceVersion === "v1.0.85" &&
      producer.sourceGenerated === false &&
      producer.shellObserved === true &&
      producer.workload?.longSessionMessages === 1000
    );
  return (
    producer.provenance === undefined ||
    producer.provenance === "source-generated"
  );
}

export function publicProducer(producer) {
  if (producer?.provenance !== "user-login") return producer;
  return {
    kind: producer.kind,
    provenance: producer.provenance,
    sourceVersion: producer.sourceVersion,
    sourceGenerated: producer.sourceGenerated,
    description: producer.description,
    status: producer.status,
    shellObserved: producer.shellObserved,
    workload: producer.workload,
  };
}
