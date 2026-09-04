//! `--replay <fixture dir>`: the JSON `scripts/dump-graph-fixture.mjs` wrote, served in-process instead of
//! relayd. Also the data source for the snapshot tests.

use crate::model::*;
use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
pub struct Fixture {
    pub dir: PathBuf,
    pub graph: Graph,
    pub state: State,
    pub story: StoryLog,
    pub panes: Vec<PaneInfo>,
    pub focused_pane: Option<String>,
    pub metrics: Option<HostMetrics>,
    /// Keyed `kind:id` (`GraphObjectRef::key`).
    pub describe: BTreeMap<String, ObjectDescription>,
    pub stories: BTreeMap<String, Vec<String>>,
    pub actions: BTreeMap<String, Vec<ObjectAction>>,
}

fn read<T: DeserializeOwned>(dir: &Path, file: &str) -> Result<T> {
    let path = dir.join(file);
    let text =
        std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

fn read_optional<T: DeserializeOwned>(dir: &Path, file: &str) -> Result<Option<T>> {
    if dir.join(file).exists() {
        Ok(Some(read(dir, file)?))
    } else {
        Ok(None)
    }
}

impl Fixture {
    pub fn load(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref();
        let panes: PanesResponse = read(dir, "panes.json")?;
        let (panes, focused_pane) = panes.into_panes();
        Ok(Self {
            dir: dir.to_path_buf(),
            graph: read(dir, "graph.json")?,
            state: read(dir, "state.json")?,
            story: read(dir, "story.json")?,
            panes,
            focused_pane,
            metrics: read_optional(dir, "metrics.json")?,
            describe: read_optional(dir, "describe.json")?.unwrap_or_default(),
            stories: read_optional(dir, "stories.json")?.unwrap_or_default(),
            actions: read_optional(dir, "actions.json")?.unwrap_or_default(),
        })
    }

    pub fn describe(&self, r: &GraphObjectRef) -> ObjectDescription {
        self.describe
            .get(&r.key())
            .cloned()
            .unwrap_or_else(|| ObjectDescription {
                title: r.id.clone(),
                lines: Vec::new(),
            })
    }

    /// The object's story: the dumped per-object story, else the global log filtered by task.
    pub fn story(&self, r: &GraphObjectRef) -> Vec<String> {
        if let Some(lines) = self.stories.get(&r.key()) {
            return lines.clone();
        }
        let task = self.graph.task_of(r).map(str::to_string);
        self.story
            .items
            .iter()
            .filter(|i| task.is_none() || i.task_id == task)
            .map(|i| i.line.clone())
            .collect()
    }

    pub fn actions(&self, r: &GraphObjectRef) -> Vec<ObjectAction> {
        if r.kind == RefKind::Inbox {
            return self
                .graph
                .inbox_item(&r.id)
                .map(|i| i.actions.clone())
                .unwrap_or_default();
        }
        self.actions.get(&r.key()).cloned().unwrap_or_default()
    }
}
