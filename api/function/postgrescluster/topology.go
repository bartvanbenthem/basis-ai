package postgrescluster

// Which member runs the primary, and how a change of primary site is carried
// out. CloudNativePG's distributed topology: every member lists the others in
// externalClusters and replica.primary names the primary. Moving the primary
// (spec.geoReplication.primarySite) is a two-step handshake across reconciles:
//
//  1. Switchover: every member's replica.primary names the target, but the
//     target keeps naming the current primary (prev) until prev, demoted,
//     publishes a demotion token. Then the target is promoted with it.
//  2. Failover: the target is promoted right away, without a token.
//
// status.primaryLocation (prev) and status.promotionToken carry the state.

// Role of a member in the topology.
type Role string

const (
	RolePrimary   Role = "primary"
	RoleReplica   Role = "replica"
	RolePromoting Role = "promoting" // the switchover target, waiting for the demotion token
)

// Promotion modes (spec.geoReplication.promotion).
const (
	Switchover = "Switchover"
	Failover   = "Failover"
)

// topologyMember is what the state machine needs to know about a member.
type topologyMember struct {
	Location string
	// Topology is the member's name in the distributed topology (its archive folder).
	Topology string
	Status   clusterStatus
}

// Placement is the decided topology.
type Placement struct {
	// Target is where the primary should be, Prev where it was (status.primaryLocation).
	Target, Prev string
	// Current is where the primary is now: Prev while waiting for its demotion token.
	Current string
	// Waiting for Prev's demotion token (switchover in progress).
	Waiting bool
	// Token the target is (or was) promoted with.
	Token   string
	Members map[string]MemberPlacement // by location
}

// MemberPlacement is one member's replica settings and role.
type MemberPlacement struct {
	Role           Role
	Primary        string
	Source         string
	PromotionToken string
}

// place decides the topology. members are in order (protected first);
// target is the location the spec asks for, prev the one status records (or
// the protected location), token the promotion token status records.
func place(members []topologyMember, target, prev, promotion, token string) Placement {
	byLocation := make(map[string]topologyMember, len(members))
	for _, m := range members {
		byLocation[m.Location] = m
	}
	p := Placement{Target: target, Prev: prev, Current: target, Members: map[string]MemberPlacement{}}
	switch {
	case target == prev:
		// Steady: keep the token the primary was promoted with.
		p.Token = token
	case promotion != Failover:
		// Switchover: prev is demoted (it names the target as primary);
		// promote the target once prev publishes a demotion token no member
		// has been promoted with yet (an old token from an earlier demotion
		// would be refused).
		demotion := byLocation[prev].Status.DemotionToken
		used := false
		for _, m := range members {
			used = used || (m.Status.LastPromotionToken != "" && m.Status.LastPromotionToken == demotion)
		}
		if demotion != "" && !used {
			p.Token = demotion
		} else {
			p.Waiting = true
			p.Current = prev
		}
	}

	targetM, prevM := byLocation[target], byLocation[prev]
	for _, m := range members {
		mp := MemberPlacement{Role: RoleReplica, Primary: targetM.Topology, Source: targetM.Topology}
		if m.Location == target {
			if p.Waiting {
				mp.Primary = prevM.Topology
			}
			// A primary's source is only used once it is demoted: the
			// member it was promoted from, or (steady) the first other one.
			mp.Source = prevM.Topology
			if target == prev {
				for _, other := range members {
					if other.Location != target {
						mp.Source = other.Topology
						break
					}
				}
			}
			if !p.Waiting {
				mp.PromotionToken = p.Token
			}
		}
		switch {
		case m.Location == p.Current:
			mp.Role = RolePrimary
		case p.Waiting && m.Location == target:
			mp.Role = RolePromoting
		}
		p.Members[m.Location] = mp
	}
	return p
}
