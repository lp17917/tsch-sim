export class MPL_Seed_Set_Entry {
    constructor(SeedID, MinSequence, lifetime) {
        this.SeedID = SeedID;
        this.MinSequence = MinSequence;
        this.lifetime = lifetime;
    }


    get_MinSequence() {
        const result = this.MinSequence;
        return result;
    }

    get_lifetime() {
        const result = this.lifetime;
        return result;
    }

    rst_lifetime(){
        this.lifetime = 0;
    }

    increment_lifetime() {
        this.lifetime = this.lifetime++;
    }

    increment_MinSequence(){
        this.MinSequence = ++this.MinSequence;
    }


}
