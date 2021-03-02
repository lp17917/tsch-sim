/**
* \file
*         "MPL" routing protocol implementation.
* \author
*         Luke Perera <luke.perera801@gmail.com>
*/

import constants from './constants.mjs';
import config from './config.mjs';
import * as log from './log.mjs';
import * as time from './time.mjs';
import * as pkt from './packet.mjs';
import * as neighbor from './neighbor.mjs';
import { rng } from './random.mjs';
import {assert, id_to_addr, round_to_ms} from './utils.mjs';
import * as utils from "./utils.mjs";
import * as networknode from "./node.mjs";
import * as MPL_Seed_Set from "./MPL_Seed_Set";
import * as MPL_Buffer_set from "./MPL_Buffer_Set";


/******constants******/

const ALL_MPL_FORWARDERS           = 0x3;
const MPL_IPV6_OPTION              = 0x6D;


/* Initialize the protocol configuration */
export function initialize(network)
{
    const default_config = {
        /*set parameters for the network*/
        /*If false uses reactive forwarding*/
        REACTIVE_FORWARDING: true,

        PROACTIVE_FORWARDING: true,
        /*30 minute lifetime for any seed set entrys*/
        SEED_SET_ENTRY_LIFETIME: 30 * 60,
        /* Minimum i value for trickle timer data messages*/
        DATA_MESSAGE_IMIN: 10 * linklayerlatency,
        /* */
        DATA_MESSAGE_K: 1,
        DATA_MESSAGE_TIMER_EXPIRATIONS: 3,
        CONTROL_MESSAGE_IMIN: 10 * worstlinklayerlatency,
        CONTROL_MESSAGE_IMAX: 5 * 60,
        CONTROL_MESSAGE_K: 1,
        CONTROL_MESSAGE_TIMER_EXPIRATIONS: 10
    };

    default_config.DATA_MESSAGE_IMAX = default_config.DATA_MESSAGE_IMIN;

    for (const key in default_config) {
        /* set the ones that have not been set from the config file */
        if (!config.hasOwnProperty(key)) {
            config[key] = default_config[key];
        }
    }
    network.set_protocol_handler(constants.PROTO_ICMP6, MPL_IPV6_OPTION,
        function(node, p) { node.routing.packet_rx(p); });
}

/*---------------------------------------------------------------------------*/


/* trickle timer for data and control*/
export class MPL
{
    /*Initialise the routing itself*/
    constructor(node) {
        this.node = node;
        /*The address of the local interface*/
        this.AddressSet = id_to_addr(this.node.id);
        /*All of the addresses within the MPL domain*/
        this.MPLInterfaceSet = null;
        /*seed set - sliding window used for getting the sequence numbers*/
        this.Seed_Set = new Map();
        /*needs seed id, Minsequence as a lower bound, lifetime which has the remaining life of an entry*/
        this.Buffered_Set = [];
        /*buffered set stores recent data packets*/
        //if node type sender make seed
        /*has the seed id, sequence no and the data message*/
        /*
        if (this.IS_SEED){
            this.seedid = ~~ (rng.random()) * 256;
        }
        */

        this.ctrltimer = null;
        this.ctrl_expires = 0;

    }




    start() {
        /* generate latency for the surrounding nodes */
        /*Add in generation of MPL packets for seeds*/
    }

    add_seed_set_entry(SeedID, MinSequence) {
        utils.assert(!this.Seed_Set.has(SeedID), `Entry with Seed ID ${SeedID} already present`);
        const index = this.Seed_Set.size;
        let new_seed_entry = new MPL_Seed_Set.MPL_Seed_Set_Entry(SeedID, MinSequence, 0);
        this.Seed_Set.set(SeedID, new_seed_entry);
    }

    get_seed_set_entry(SeedID){
        const result = this.Seed_Set.get(SeedID);
        utils.assert(result !== undefined, `unknown node ID ${SeedID}`);
        return result;
    }

    increment_seed_lifetimes(){
        for (let key of this.Seed_Set){
            key.increment_lifetime();
        }
    }

    expire_seed_set(){
        for (let key of this.Seed_Set) {
            if (key.get_lifetime() >= this.node.config.SEED_SET_ENTRY_LIFETIME) {
                this.remove_seed(key);
            }
        }
    }

    remove_seed(SeedID) {
        let seed_removed = this.Seed_Set.delete(SeedID);
        utils.assert(seed_removed !== false, `${SeedID} did not exist in seed set`);
    }

    find_space() {
        for (let i = 0; i < this.Buffered_Set.length; i++) {
            if (this.Buffered_Set[i] === undefined) { return i; }
        }
        return false;
    }

    is_highest_sequence_no(seedid){
        let x = 0;
        let xmax = 0;
        for (let i = 0; i < this.Buffered_Set.length; i++) {
            if (xmax < this.Buffered_Set[i].get_SequenceNumber() && this.Buffered_Set.SeedID === seedid) {
                x = i;
                xmax = this.Buffered_Set[i].get_SequenceNumber();
            }
        }
        return x;
    }

    add_new_buffer_entry(SeedID, SequenceNumber, DataMessage){
        let new_data_entry = new MPL_Buffer_set.MPL_Buffer_Set_Entry(SeedID, SequenceNumber,DataMessage);
        //Check to see if there is a free space in the buffer
        let space = this.find_space();
        //If the bufferset is full add to the end of the set
        if (!space){
            this.Buffered_Set.push(new_data_entry);
        }
        //If there is an unused slot in the bufferset then put the new data entry there
        else {
            this.Buffered_Set[space] = new_data_entry;
        }

    }

    sweep_buffer_set(){
        for (let entry of this.Buffered_Set) {
            if (entry.get_SequenceNumber() <= this.Seed_Set.find(entry.SeedID()).get_MinSequence()) {
                //Buffer set deleted rather than spliced to preserve indices for timers
                entry = undefined;
            }
        }
    }

    start_new_data_timer(buffer_entry_index){
        this.Buffered_Set[buffer_entry_index].timer =   time.add_timer(this.node.config.DATA_MESSAGE_IMAX, false, this, function(mpl) {
            mpl.data_timer_expire(buffer_entry_index); });
    }

    data_timer_expire(buffer_entry_index) {
        time.remove_timer(this.Buffered_Set[buffer_entry_index].timer);
        this.Buffered_Set[buffer_entry_index].increment_expirations();
        if (this.Buffered_Set[buffer_entry_index].trickle_E < this.node.config.DATA_MESSAGE_TIMER_EXPIRATIONS) {
            const timer_length = rng.trickle_random(this.node.config.DATA_MESSAGE_IMAX);
            this.Buffered_Set[buffer_entry_index].timer = time.add_timer(timer_length, false, this, function (mpl) {
                mpl.data_timer_expire(buffer_entry_index);
            });
        }
        this.data_message_send(this.Buffered_Set[buffer_entry_index]);
    }

    start_new_control_timer() {
        const ctrl_timer_length = rng.trickle_random(this.node.config.CONTROL_MESSAGE_IMAX);
        this.ctrltimer = time.add_timer(ctrl_timer_length, false, this, function (mpl) {
            mpl.control_trickle_expire();})
    }

    rst_control_trickle() {
        this.ctrl_expires = 0;
        time.remove_timer(this.ctrltimer);
        this.start_new_control_timer();
    }

    control_trickle_expire(){
        this.ctrl_expires = ++this.ctrl_expires;
        time.remove_timer(this.ctrltimer);
        if (!(this.ctrl_expires >= this.node.config.CONTROL_MESSAGE_TIMER_EXPIRATIONS)){
            this.control_message_send();
        }
        this.control_message_send();
    }

    add_set_timers(packet){
        //Add the data entry
        this.bufferindex = this.add_new_buffer_entry(packet.seedid,packet.seqnum,packet.length);
        if (packet.M === 1){
            this.get_seed_set_entry(packet.seedid).increment_MinSequence();
        }
        if (this.node.config.PROACTIVE_FORWARDING){
            //start trickle timer for data message
            this.start_new_data_timer(this.bufferindex);
        }
        if (this.node.config.REACTIVE_FORWARDING){
            //if not on and not zero start control timer
            //if on reset trickle timer
            //this.start_new_control_timer();
        }
        this.sweep_buffer_set();
    }

    data_message_send(packet) {
        packet.mpltype = 0;
        this.node.add_packet(packet);
    }

    control_message_send(){
        let seeds = this.Seed_Set;
        this.control_data = new Map();
        for (let key of this.Seed_Set) {
            let buffered_seq_nos = [];
            let maxseqno = this.is_highest_sequence_no(key);
            for (let j = key.get_MinSequence(); j <= maxseqno; j++){
                buffered_seq_nos.push(false);
            }
            for (let i = 0; i < this.Buffered_Set.length; i++) {
                if (this.Buffered_Set[i].SeedID === key){
                    buffered_seq_nos[this.Buffered_Set[i].get_SequenceNumber() - key.get_MinSequence] = true;
                }
            }
            let mpl_msgs = {min_seq: key.get_MinSequence(), msg_total: buffered_seq_nos.length, msgs: buffered_seq_nos}
            this.control_data.set(key, mpl_msgs);
        }
        const packet = new pkt.Packet(this.node, constants.BROADCAST_ID , this.control_data, true);
        packet.packet_protocol = constants.PROTO_ICMP6;
        packet.msg_type = MPL_IPV6_OPTION;
        packet.mpltype = 1;
        packet.seedlist = seeds;
        this.node.add_packet(packet);
    }

    packet_rx(packet) {
        //check it is an mpl packet and if it is a data or control
        if (packet.msg_type === MPL_IPV6_OPTION && packet.mpltype === 0) {

            if (!this.Buffered_Set.get(packet.seedid, packet.seqnum, packet.length)) {

                //If the packet is in the seed set and more than the min sequence no
                if (((this.Seed_Set.has(packet.seedid)) && (packet.seqnum > this.get_seed_set_entry(packet.seedid).get_MinSequence()))) {
                    //reset lifetime for this seeds entry
                    this.get_seed_set_entry(packet.seedid).rst_lifetime();
                    //add to buffer set-------------------------------------------------
                    this.add_set_timers(packet);

                    //If the packet does not have a respective seed set entry for the id
                } else if (!(this.Seed_Set.has(packet.seedid)) ) {
                    //generate seed set and add to buffer set
                    this.add_seed_set_entry(packet.seedid, packet.seqnum)
                    this.add_set_timers(packet);


                }
            } else if (packet.msg_type === MPL_IPV6_OPTION && packet.mpltype === 1) {

            }
            return false;
        }
    }

    on_tx(neighbor, packet, is_ok, is_ack_required) {
        /* nothing */
    }

    on_prepare_tx_packet(packet){
        packet.m = 0;
        if (this.is_highest_sequence_no(packet.seedid)){
            packet.m = 1;
        }
        /* nothing */
    }

    on_forward(packet, newpacket) {
        return false;
    }

    on_new_time_source(old_time_source, new_time_source) {
        this.increment_seed_lifetimes();
        if (new_time_source == null) {
            this.node.routes.remove_default_route();
        } else {
            this.node.routes.add_default_route(new_time_source.id);
        }
        this.expire_seed_set();
    }

    local_repair() {
        /* nothing */
    }

    is_joined() {
        return this.node.has_joined;
    }

    on_periodic_timer() {
        /* nothing */
    }

    stats_get() {
        return {
            routing_tx: 0,
            routing_rx: 0,
            routing_join_time_sec: 0,
            routing_num_parent_changes : 1
        };
    }
}
