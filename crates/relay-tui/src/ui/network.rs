//! Who is a brain and who is a sub.
//!
//! A **brain** is an agent you prompted: the planner you gave the mission to, a task you asked for
//! yourself, or an agent you launched and are typing at. A **sub** is an agent a brain called. The
//! model already records the difference — a task's contract edge comes from its parent agent when it
//! was delegated, and from the planner or the human when it was not — so this reads it rather than
//! inventing a second source of truth.
//!
//! Brains are numbered in the order they appear, subs within their brain: `brain 1`, `sub 1.2`. The
//! role (`backend`) is not lost; it stays on the node's detail line, which has room for it.

use crate::model::*;
use std::collections::BTreeMap;

/// Where an agent sits in the two-layer network, and what to call it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Naming {
    /// 0 = brains, 1 = subs, 2 = the verifier.
    pub tier: usize,
    /// `brain 1`, `sub 1.2`; deeper delegation keeps its whole path (`sub 1.2.1`) rather than
    /// pretending the layer it came from does not exist.
    pub label: String,
    /// `1` or `1.2` — the number without the word, for anything too narrow for the label.
    pub number: String,
}

/// The node that gave this one its contract, if any: its caller.
fn caller_of<'a>(graph: &'a Graph, node_id: &str) -> Option<&'a str> {
    graph
        .edges
        .iter()
        .find(|e| e.kind == GraphEdgeKind::Contract && e.to == node_id)
        .map(|e| e.from.as_str())
}

/// Is this node one the user prompted directly?
fn is_brain(graph: &Graph, node: &GraphNode) -> bool {
    match node.kind {
        // The planner is the agent a mission is handed to.
        GraphNodeKind::Planner => true,
        GraphNodeKind::Agent => match caller_of(graph, &node.id) {
            // `human` means you asked for this work yourself; the human node is not drawn, so the
            // task it points at is the brain.
            None | Some("human") => true,
            Some(caller) => caller == "human" || graph.node(caller).is_none(),
        },
        _ => false,
    }
}

/// Names every agent in the network. `unattached` are agents relayd hosts that no contract accounts
/// for — you launched them, so they are brains.
pub fn name_nodes(
    graph: &Graph,
    unattached: &[GraphNode],
    planner_present: bool,
) -> BTreeMap<String, Naming> {
    let mut naming: BTreeMap<String, Naming> = BTreeMap::new();
    let agents: Vec<&GraphNode> = graph
        .nodes
        .iter()
        .filter(|n| match n.kind {
            GraphNodeKind::Agent => true,
            // A planner nobody spawned is not on the network, so it is not brain 1 either.
            GraphNodeKind::Planner => planner_present,
            _ => false,
        })
        .chain(unattached.iter())
        .collect();

    // Brains first, in the order the graph lists them, so the numbers are stable across a redraw.
    let mut brains: Vec<&str> = Vec::new();
    for node in &agents {
        let launched_by_hand = unattached.iter().any(|u| u.id == node.id);
        if launched_by_hand || is_brain(graph, node) {
            brains.push(&node.id);
            let number = (brains.len()).to_string();
            naming.insert(
                node.id.clone(),
                Naming {
                    tier: 0,
                    label: format!("brain {number}"),
                    number,
                },
            );
        }
    }

    // Then everything a brain called, and anything those called in turn.
    let mut pending: Vec<&GraphNode> = agents
        .iter()
        .copied()
        .filter(|n| !naming.contains_key(&n.id))
        .collect();
    let mut children: BTreeMap<String, usize> = BTreeMap::new();
    // Each pass names the nodes whose caller is already named; delegation is a tree, so this ends.
    loop {
        let mut named_this_pass = Vec::new();
        for node in &pending {
            let Some(caller) = caller_of(graph, &node.id) else {
                continue;
            };
            let Some(parent) = naming.get(caller).cloned() else {
                continue;
            };
            let index = children.entry(caller.to_string()).or_insert(0);
            *index += 1;
            let number = format!("{}.{}", parent.number, index);
            naming.insert(
                node.id.clone(),
                Naming {
                    tier: 1,
                    label: format!("sub {number}"),
                    number,
                },
            );
            named_this_pass.push(node.id.clone());
        }
        if named_this_pass.is_empty() {
            break;
        }
        pending.retain(|n| !named_this_pass.contains(&n.id));
    }

    // An agent whose caller is not in the graph at all still belongs on the network; it is drawn as a
    // sub with no number rather than dropped, because dropping it would hide real work.
    for node in pending {
        naming.insert(
            node.id.clone(),
            Naming {
                tier: 1,
                label: node.label.clone(),
                number: String::new(),
            },
        );
    }
    naming
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::*;

    fn agent(id: &str, label: &str) -> GraphNode {
        GraphNode {
            pane_id: None,
            id: id.to_string(),
            kind: GraphNodeKind::Agent,
            label: label.to_string(),
            task_id: Some(id.to_string()),
            runtime: None,
            task_state: None,
            handoff_state: None,
            column: 1,
            status: VisualStatus::Working,
            badge: None,
        }
    }

    fn contract(from: &str, to: &str) -> GraphEdge {
        GraphEdge {
            id: format!("contract:{to}"),
            kind: GraphEdgeKind::Contract,
            from: from.to_string(),
            to: to.to_string(),
            task_id: Some(to.to_string()),
            label: "v1".to_string(),
            status: VisualStatus::Done,
            attention: false,
            version: Some(1),
        }
    }

    fn graph_of(nodes: Vec<GraphNode>, edges: Vec<GraphEdge>) -> Graph {
        Graph {
            nodes,
            edges,
            inbox: Vec::new(),
            ..Graph::default()
        }
    }

    #[test]
    fn the_agent_you_prompted_is_a_brain_and_the_one_it_called_is_a_sub() {
        let graph = graph_of(
            vec![agent("t-one", "backend"), agent("t-two", "tests")],
            vec![contract("human", "t-one"), contract("t-one", "t-two")],
        );

        let naming = name_nodes(&graph, &[], true);

        assert_eq!(naming["t-one"].label, "brain 1");
        assert_eq!(naming["t-one"].tier, 0);
        assert_eq!(naming["t-two"].label, "sub 1.1");
        assert_eq!(naming["t-two"].tier, 1);
    }

    #[test]
    fn a_brain_numbers_its_own_subs() {
        let graph = graph_of(
            vec![
                agent("t-one", "backend"),
                agent("t-a", "tests"),
                agent("t-b", "docs"),
            ],
            vec![
                contract("human", "t-one"),
                contract("t-one", "t-a"),
                contract("t-one", "t-b"),
            ],
        );

        let naming = name_nodes(&graph, &[], true);

        assert_eq!(naming["t-a"].label, "sub 1.1");
        assert_eq!(naming["t-b"].label, "sub 1.2");
    }

    #[test]
    fn two_prompts_are_two_brains_each_with_their_own_numbering() {
        let graph = graph_of(
            vec![
                agent("t-one", "backend"),
                agent("t-two", "frontend"),
                agent("t-a", "tests"),
                agent("t-b", "docs"),
            ],
            vec![
                contract("human", "t-one"),
                contract("human", "t-two"),
                contract("t-one", "t-a"),
                contract("t-two", "t-b"),
            ],
        );

        let naming = name_nodes(&graph, &[], true);

        assert_eq!(naming["t-one"].label, "brain 1");
        assert_eq!(naming["t-two"].label, "brain 2");
        assert_eq!(naming["t-a"].label, "sub 1.1", "brain 1's first sub");
        assert_eq!(naming["t-b"].label, "sub 2.1", "brain 2's first, not 1.2");
    }

    #[test]
    fn tasks_the_human_proposed_are_brains_even_when_a_planner_exists() {
        // live-1 came from a plan file: its contracts are sent by `human`, not by the planner. You
        // asked for that work, so those agents are the ones you prompt.
        let graph = fixture("live-1").graph;

        let naming = name_nodes(&graph, &[], true);

        assert_eq!(naming["planner"].label, "brain 1");
        for id in ["t-backend-auth", "t-frontend-login"] {
            assert!(
                naming[id].label.starts_with("brain "),
                "{id}'s contract comes from the human: {}",
                naming[id].label
            );
            assert_eq!(naming[id].tier, 0);
        }
    }

    #[test]
    fn a_task_the_planner_proposed_is_one_of_its_subs() {
        let mut graph = fixture("live-1").graph;
        for edge in graph.edges.iter_mut() {
            if edge.kind == GraphEdgeKind::Contract && edge.to == "t-backend-auth" {
                edge.from = "planner".to_string();
            }
        }

        let naming = name_nodes(&graph, &[], true);

        assert_eq!(naming["planner"].label, "brain 1");
        assert_eq!(naming["t-backend-auth"].label, "sub 1.1");
        assert_eq!(naming["t-backend-auth"].tier, 1);
    }

    #[test]
    fn an_agent_you_launched_yourself_is_a_brain_too() {
        let graph = fixture("live-1").graph;
        let loose = agent("relay:7", "scout");

        let naming = name_nodes(&graph, std::slice::from_ref(&loose), true);

        assert!(
            naming["relay:7"].label.starts_with("brain "),
            "you are the one prompting it: {}",
            naming["relay:7"].label
        );
        assert_eq!(naming["relay:7"].tier, 0);
    }

    #[test]
    fn deeper_delegation_keeps_its_whole_path_rather_than_being_hidden() {
        // relayd refuses this, but if a contract like it ever exists the network must not lie.
        let graph = graph_of(
            vec![
                agent("t-one", "backend"),
                agent("t-a", "tests"),
                agent("t-deep", "fixtures"),
            ],
            vec![
                contract("human", "t-one"),
                contract("t-one", "t-a"),
                contract("t-a", "t-deep"),
            ],
        );

        let naming = name_nodes(&graph, &[], true);

        assert_eq!(naming["t-deep"].label, "sub 1.1.1");
    }

    #[test]
    fn the_verifier_and_the_human_are_not_named_as_agents() {
        let naming = name_nodes(&fixture("live-1").graph, &[], true);

        assert!(!naming.contains_key("verifier"));
        assert!(!naming.contains_key("human"));
    }
}
