//! The event stream: durable append to the store, then live fan-out to followers and a wake-up for the
//! router. An event is "in the stream" once its append committed.

use std::sync::Arc;

use tokio::sync::{Notify, broadcast};

use crate::store::{EventRecord, NewEvent, Store, StoreError};

/// Live followers each get this many events of slack before they fall back to reading the store.
const LIVE_SLACK: usize = 256;

#[derive(Clone)]
pub(crate) struct Stream {
    store: Store,
    live: broadcast::Sender<Arc<EventRecord>>,
    route_wake: Arc<Notify>,
}

impl Stream {
    pub(crate) fn new(store: Store, route_wake: Arc<Notify>) -> Self {
        let (live, _) = broadcast::channel(LIVE_SLACK);
        Self {
            store,
            live,
            route_wake,
        }
    }

    /// Appends events in one transaction and returns them with their IDs.
    pub(crate) async fn append(
        &self,
        events: Vec<NewEvent>,
    ) -> Result<Vec<EventRecord>, StoreError> {
        if events.is_empty() {
            return Ok(Vec::new());
        }
        let records = self.store.append_events(events).await?;
        for record in &records {
            let _ = self.live.send(Arc::new(record.clone()));
        }
        self.route_wake.notify_one();
        Ok(records)
    }

    /// Subscribes to events appended from now on.
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Arc<EventRecord>> {
        self.live.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tests::{event, open_temp};

    #[tokio::test]
    async fn followers_share_committed_events_in_order() {
        let (store, _writer, _dir) = open_temp("stream-shared");
        let stream = Stream::new(store.clone(), Arc::new(Notify::new()));
        let mut first = stream.subscribe();
        let mut second = stream.subscribe();
        let mut rich = event("j", "run.done", &[]);
        rich.body = Some("body".repeat(16 * 1024));
        rich.body_path = Some("/private/body.txt".into());
        rich.fields = Some(r#"{"result":"done"}"#.into());
        rich.urgent = true;
        let records = stream
            .append(vec![rich, event("j", "run.failed", &[])])
            .await
            .unwrap();
        assert!(records[0].id < records[1].id);
        for record in &records {
            let one = first.try_recv().unwrap();
            let two = second.try_recv().unwrap();
            assert!(Arc::ptr_eq(&one, &two));
            assert_eq!(one.as_ref(), record);
            assert_eq!(
                serde_json::to_value(one.as_ref()).unwrap(),
                serde_json::to_value(record).unwrap()
            );
        }
        let stored = store.read(|r| r.events_after(0, 10)).await.unwrap();
        assert_eq!(stored, records);
        assert!(matches!(
            first.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn lagged_follower_recovers_from_store_after_cursor() {
        let (store, _writer, _dir) = open_temp("stream-lag");
        let stream = Stream::new(store.clone(), Arc::new(Notify::new()));
        let mut live = stream.subscribe();
        stream
            .append(vec![event("j", "run.done", &[])])
            .await
            .unwrap();
        let cursor = live.try_recv().unwrap().id;
        let records = stream
            .append(
                (0..=LIVE_SLACK)
                    .map(|_| event("j", "run.done", &[]))
                    .collect(),
            )
            .await
            .unwrap();
        assert!(matches!(
            live.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(1))
        ));
        let recovered = store
            .read(move |r| r.events_after(cursor, u32::try_from(LIVE_SLACK).unwrap() + 1))
            .await
            .unwrap();
        assert_eq!(recovered, records);
        for record in &recovered[1..] {
            assert_eq!(live.try_recv().unwrap().as_ref(), record);
        }
    }
}
